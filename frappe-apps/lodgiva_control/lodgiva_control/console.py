"""Operator console: every hotel on the platform, and what needs a hand.

One call, `overview`, joins three sources an operator otherwise checks by hand:
the Hotel Environment records, the site directories actually on disk, and a
health read taken on each hotel's own site. Each row then carries a list of
issues phrased as what to do, so the page is a to-do list, not a report.

Health is read the same way `scheduler.usage_for` reads usage: a short python
run against the hotel's site, never a connection from this process into
another site's database.
"""

from __future__ import annotations

import os
import subprocess

import frappe
from frappe.utils import date_diff, get_datetime, getdate, now_datetime, nowdate

from lodgiva_control import provisioning

HEALTH_TIMEOUT = 60
# ponytail: per-site subprocess, ~1-2 s each, cached 5 min. Fine for tens of
# hotels; past that, have the sweep write health to a table and read that.
HEALTH_TTL = 300

HEALTH_SCRIPT = r"""
import frappe, frappe.utils.scheduler, json, sys
frappe.init(site=sys.argv[1])
frappe.connect()
db = frappe.db
staff = ("Administrator", "Guest")
out = {
    "users": db.count("User", {"enabled": 1, "user_type": "System User", "name": ["not in", staff]}),
    "last_login": str(db.sql("select max(last_login) from tabUser where name not in %s", [staff])[0][0] or ""),
    "errors_7d": db.sql("select count(*) from `tabError Log` where creation > now() - interval 7 day")[0][0],
    "scheduler_off": bool(frappe.utils.scheduler.is_scheduler_disabled()),
    "access_mode": frappe.conf.get("lodgiva_access_mode") or "full",
    # the scheduler can be "on" with no process running it: the last time it
    # enqueued anything is the heartbeat (logs are only kept for some jobs)
    "last_job": str(db.sql("select max(last_execution) from `tabScheduled Job Type`")[0][0] or ""),
}
import importlib, os, subprocess
ver = {"frappe": frappe.__version__}
for app in ("kamra", "lodgiva_nigeria"):
    try:
        mod = importlib.import_module(app)
        sha = subprocess.run(["git", "-C", os.path.dirname(os.path.dirname(mod.__file__)), "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        ver[app] = getattr(mod, "__version__", "") + (f"+{sha}" if sha else "")
    except Exception:
        ver[app] = ""
out["version"] = ver
bdir = frappe.get_site_path("private", "backups")
files = [os.path.join(bdir, f) for f in os.listdir(bdir)] if os.path.isdir(bdir) else []
import datetime
out["last_local_backup"] = str(datetime.datetime.fromtimestamp(int(max(os.path.getmtime(f) for f in files)))) if files else ""
if db.table_exists("Property"):
    props = frappe.get_all("Property", pluck="name")
    out["properties"] = len(props)
    out["rooms"] = db.count("Room")
    out["reservations"] = db.count("Reservation")
    out["bookings_30d"] = db.sql("select count(*) from tabReservation where creation > now() - interval 30 day")[0][0]
    out["last_booking"] = str(db.sql("select max(creation) from tabReservation")[0][0] or "")
    out["in_house"] = db.count("Reservation", {"status": "Checked In"})
    out["overdue"] = db.sql("select count(*) from tabReservation where status='Checked In' and check_out_date < curdate()")[0][0]
    try:
        from kamra.business_date import get_business_date
        out["business_date"] = min((str(get_business_date(p)) for p in props), default="")
    except Exception:
        out["business_date"] = ""
print("HEALTH" + json.dumps(out))
"""


def _bench() -> str:
    return frappe.utils.get_bench_path()


def sites_on_disk() -> list[str]:
    root = os.path.join(_bench(), "sites")
    return sorted(
        d for d in os.listdir(root)
        if os.path.isfile(os.path.join(root, d, "site_config.json")) and d != frappe.local.site
    )


def _read_health(bench: str, site: str) -> dict:
    """One health read. No frappe.local use, so it is safe in a thread."""
    import json

    try:
        result = subprocess.run(
            [f"{bench}/env/bin/python", "-c", HEALTH_SCRIPT, site],
            cwd=f"{bench}/sites", capture_output=True, text=True, timeout=HEALTH_TIMEOUT,
        )
        line = next((ln for ln in result.stdout.splitlines() if ln.startswith("HEALTH")), None)
        text = (result.stderr or result.stdout).strip()
        return json.loads(line[6:]) if line else {
            "error": text.splitlines()[-1][:300] if text else "no output"
        }
    except Exception as e:  # a wedged site must not take the console down
        return {"error": str(e)[:300]}


def health_for(sites: list[str], refresh: bool = False) -> dict[str, dict]:
    """Health of many sites: cached reads, the rest 4 at a time.

    ponytail: 4 parallel python processes; past ~50 hotels, have the sweep
    write health to a table and read that instead."""
    from concurrent.futures import ThreadPoolExecutor

    key = lambda s: f"lodgiva_console_health:{s}"  # noqa: E731
    out = {} if refresh else {s: h for s in sites if (h := frappe.cache.get_value(key(s)))}
    todo = [s for s in sites if s not in out]
    bench = _bench()
    with ThreadPoolExecutor(max_workers=4) as pool:
        for site, health in zip(todo, pool.map(lambda s: _read_health(bench, s), todo)):
            health["checked_at"] = str(now_datetime())
            frappe.cache.set_value(key(site), health, expires_in_sec=HEALTH_TTL)
            out[site] = health
    return out


def site_health(site: str, refresh: bool = False) -> dict:
    return health_for([site], refresh)[site]


def hotel_url(site: str, public_url: str | None = None) -> str:
    # A quick-tunnel URL outlives its cloudflared process (a reboot never
    # calls tunnel.stop), so only trust it while the tunnel is running.
    if public_url and "trycloudflare.com" in public_url:
        from lodgiva_control import tunnel
        if not tunnel.running_pid(site):
            public_url = None
    return public_url or provisioning.hotel_base_url(site)


def issues_for(row: dict, today: str | None = None) -> list[dict]:
    """What an operator should do about this hotel, worst first.

    Pure: takes the joined row, returns [{level, text}], so it is testable
    without a bench. level is critical | warning | info.
    """
    today = getdate(today or nowdate())
    out: list[tuple[str, str]] = []
    add = lambda level, text: out.append((level, text))  # noqa: E731

    status = row.get("status")
    sub = row.get("subscription") or {}
    health = row.get("health") or {}

    if not row.get("registered"):
        add("warning", "Site exists on disk with no Hotel Environment record: not billed and not "
                       "covered by the daily sweep. Register it or remove the site.")
    if status == "Failed":
        add("critical", "Provisioning failed. Read the log, remove the half-built site on the "
                        "server, then Retry.")
    elif status == "Provisioning":
        started = row.get("modified") or row.get("creation")
        if started and (now_datetime() - get_datetime(started)).total_seconds() > 3600:
            add("critical", "Provisioning has run for over an hour. Check the worker on the "
                            "'long' queue; the job may have died.")
        else:
            add("info", "Provisioning in progress.")
    elif status == "Draft" and row.get("registered"):
        add("info", "Saved but never submitted, so provisioning has not started.")
    if status == "Active" and not row.get("on_disk"):
        add("critical", "Marked Active but the site is missing on disk. The hotel cannot sign in.")

    if row.get("registered") and status == "Active" and not sub:
        add("warning", "No subscription: this hotel is never billed or restricted.")
    state = sub.get("state")
    if state == "past_due":
        add("warning", f"Payment failed. Grace ends {sub.get('grace_ends_on') or 'soon'}; "
                       "contact the owner before access is restricted.")
    elif state == "unpaid":
        add("critical", "Unpaid after grace. Collect payment, then Mark paid.")
    elif state == "trialing" and sub.get("trial_ends_on"):
        left = date_diff(sub["trial_ends_on"], today)
        if left < 0:
            add("warning", f"Trial ended {-left} day(s) ago but is still trialing: the daily "
                           "sweep has not run. Check the scheduler on the control site.")
        elif left <= 3:
            add("info", f"Trial ends in {left} day(s). Good moment to call the owner.")
    if sub.get("access_mode") == "read_only" or health.get("access_mode") == "read_only":
        add("critical", "Read-only: the hotel cannot take bookings or post charges.")

    if health.get("error"):
        add("critical", f"Site did not answer the health check: {health['error']}")
    elif health:
        if health.get("scheduler_off"):
            add("critical", "Scheduler is off on this site: no night audit, no reminders. "
                            "Run: bench --site <site> enable-scheduler")
        if not health.get("users"):
            add("warning", "No staff accounts yet: onboarding has not started.")
        last = health.get("last_login")
        if last:
            idle = date_diff(today, getdate(last))
            if idle > 7:
                add("warning", f"No staff sign-in for {idle} days. Check in with the hotel.")
        elif health.get("users"):
            add("warning", "Staff accounts exist but nobody has ever signed in.")
        if health.get("properties") == 0 or health.get("rooms") == 0:
            add("warning", "No rooms set up: the hotel cannot sell anything yet.")
        bd = health.get("business_date")
        if bd:
            behind = date_diff(today, getdate(bd))
            if behind > 1:
                add("warning", f"Business date is {behind} days behind today: the night audit "
                               "is not running. Clear overdue departures, then run the catch-up.")
        if health.get("overdue"):
            add("info", f"{health['overdue']} guest(s) past departure still checked in.")
        if health.get("errors_7d"):
            add("warning", f"{health['errors_7d']} server error(s) in the last 7 days. "
                           "See Error Log on the hotel's site.")

    rank = {"critical": 0, "warning": 1, "info": 2}
    issues = [{"level": lv, "text": tx} for lv, tx in sorted(out, key=lambda x: rank[x[0]])]
    return issues


def exceptions_for(row: dict, now=None) -> list[dict]:
    """The platform exception queue entries for one hotel.

    Pure, like issues_for. Each entry says which site, what happened, when,
    and the next action an operator can take: {site, kind, level, what,
    when, action}. action = {"act": <console button>, "label"} or
    {"href", "label"}.
    """
    from lodgiva_control.backups import STALE_HOURS

    now = get_datetime(now or now_datetime())
    site, env = row.get("site_name"), row.get("name")
    status = row.get("status")
    sub = row.get("subscription") or {}
    health = row.get("health") or {}
    out = []

    def add(kind, level, what, when, action):
        out.append({"site": site, "hotel": env, "kind": kind, "level": level, "what": what,
                    "when": str(when or ""), "action": action})

    record = {"href": f"/app/hotel-environment/{env}", "label": "Provisioning history"} if env else None
    if status == "Failed":
        add("provisioning", "critical", "Provisioning failed: " + (row.get("last_log") or "see log"),
            row.get("modified"), {"act": "retry", "name": env, "label": "Retry provisioning"})
    elif status == "Provisioning" and row.get("modified") and \
            (now - get_datetime(row["modified"])).total_seconds() > 3600:
        add("provisioning", "critical", "Provisioning stuck for over an hour", row["modified"], record)

    if status == "Active" and not health.get("error"):
        if health.get("scheduler_off"):
            add("jobs", "critical", "Scheduler disabled: night audit and reminders are not running",
                health.get("last_job"), record)
        else:
            last = health.get("last_job")
            if not last or (now - get_datetime(last)).total_seconds() > 2 * 3600:
                add("jobs", "critical", "Scheduler has not run a job in 2 hours: the scheduler process is down",
                    last or "never", record)
        bd = health.get("business_date")
        if bd and date_diff(now.date(), getdate(bd)) > 1:
            add("jobs", "warning", f"Night audit missed: business date {bd}", bd, record)

    if status == "Active":
        offsite = (row.get("backups") or {}).get("Off-site copy")
        age = (now - get_datetime(offsite["at"])).total_seconds() / 3600 if offsite else None
        if age is None or age > STALE_HOURS:
            add("backup", "critical", "No off-server backup " + (f"for {int(age)} hours" if age else "on record"),
                offsite["at"] if offsite else "never",
                {"href": f"/app/backup-event?site_name={site}", "label": "Backup history"})

    state = sub.get("state")
    if state in ("past_due", "unpaid"):
        add("subscription", "critical" if state == "unpaid" else "warning",
            f"Subscription {state.replace('_', ' ')}; grace ends {sub.get('grace_ends_on') or '-'}, "
            f"access {sub.get('access_mode') or 'full'}",
            sub.get("grace_ends_on"), {"act": "paid", "name": sub.get("name"), "label": "Mark paid"})
    applied = health.get("access_mode")
    if sub and applied and not health.get("error") and applied != (sub.get("access_mode") or "full"):
        add("subscription", "critical",
            f"Access mode mismatch: subscription says {sub.get('access_mode')}, site applies {applied}",
            row.get("checked_at"), {"href": f"/app/hotel-subscription/{sub.get('name')}", "label": "Subscription"})
    return out


@frappe.whitelist()
def overview(refresh: int = 0) -> dict:
    frappe.only_for(["Lodgiva Operator", "System Manager"])
    refresh = bool(int(refresh or 0))

    subs = {
        s.hotel_environment: s
        for s in frappe.get_all(
            "Hotel Subscription",
            fields=["name", "hotel_environment", "plan", "state", "access_mode",
                    "trial_ends_on", "grace_ends_on"],
        )
    }
    on_disk = set(sites_on_disk())
    rows = []
    for h in frappe.get_all(
        "Hotel Environment",
        fields=["name", "customer_name", "subdomain", "site_name", "owner_email", "status",
                "property_name", "city", "state as region", "public_url", "creation",
                "modified", "provision_log"],
        order_by="creation desc",
    ):
        log = (h.pop("provision_log") or "").strip().splitlines()
        rows.append({
            **h, "registered": True, "on_disk": h.site_name in on_disk,
            "subscription": subs.get(h.name), "last_log": log[-1][:300] if log else "",
        })
    registered = {r["site_name"] for r in rows}
    for site in sorted(on_disk - registered):
        rows.append({"name": None, "customer_name": site, "site_name": site, "status": "Unregistered",
                     "registered": False, "on_disk": True})

    from lodgiva_control.backups import latest
    from lodgiva_control.support import active_grants

    healths = health_for([r["site_name"] for r in rows if r["on_disk"]], refresh)
    for r in rows:
        r["health"] = healths.get(r["site_name"]) if r["on_disk"] else None
        r["checked_at"] = (r["health"] or {}).get("checked_at")
        r["url"] = hotel_url(r["site_name"], r.get("public_url"))
        r["backups"] = latest(r["site_name"])
        r["support"] = active_grants(r["name"]) if r.get("name") else []
        r["issues"] = issues_for(r)
    exceptions = [e for r in rows for e in exceptions_for(r)]
    exceptions.sort(key=lambda e: ({"critical": 0, "warning": 1}.get(e["level"], 2), e["when"]))

    count = lambda pred: sum(1 for r in rows if pred(r))  # noqa: E731
    return {
        "rows": rows,
        "exceptions": exceptions,
        "summary": {
            "hotels": len(rows),
            "active": count(lambda r: r.get("status") == "Active"),
            "trialing": count(lambda r: (r.get("subscription") or {}).get("state") == "trialing"),
            "paying": count(lambda r: (r.get("subscription") or {}).get("state") == "active"),
            "at_risk": count(lambda r: (r.get("subscription") or {}).get("state") in ("past_due", "unpaid")),
            "attention": count(lambda r: any(i["level"] == "critical" for i in r["issues"])),
            "bookings_30d": sum(((r.get("health") or {}).get("bookings_30d") or 0) for r in rows),
        },
        "generated_at": str(now_datetime()),
    }
