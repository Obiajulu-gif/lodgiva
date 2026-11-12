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
}
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


def site_health(site: str, refresh: bool = False) -> dict:
    key = f"lodgiva_console_health:{site}"
    if not refresh and (hit := frappe.cache.get_value(key)):
        return hit
    try:
        result = subprocess.run(
            [f"{_bench()}/env/bin/python", "-c", HEALTH_SCRIPT, site],
            cwd=f"{_bench()}/sites", capture_output=True, text=True, timeout=HEALTH_TIMEOUT,
        )
        line = next((ln for ln in result.stdout.splitlines() if ln.startswith("HEALTH")), None)
        text = (result.stderr or result.stdout).strip()
        health = frappe.parse_json(line[6:]) if line else {
            "error": text.splitlines()[-1][:300] if text else "no output"
        }
    except Exception as e:  # a wedged site must not take the console down
        health = {"error": str(e)[:300]}
    health["checked_at"] = str(now_datetime())
    frappe.cache.set_value(key, health, expires_in_sec=HEALTH_TTL)
    return health


def hotel_url(site: str, public_url: str | None = None) -> str:
    # A quick-tunnel URL outlives its cloudflared process (a reboot never
    # calls tunnel.stop), so only trust it while the tunnel is running.
    if public_url and "trycloudflare.com" in public_url:
        from lodgiva_control import tunnel
        if not tunnel.running_pid(site):
            public_url = None
    template = frappe.conf.get("lodgiva_hotel_url") or "https://{site}"
    return public_url or template.format(site=site)


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
    return [{"level": lv, "text": tx} for lv, tx in sorted(out, key=lambda x: rank[x[0]])]


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

    for r in rows:
        r["health"] = site_health(r["site_name"], refresh) if r["on_disk"] else None
        r["url"] = hotel_url(r["site_name"], r.get("public_url"))
        r["issues"] = issues_for(r)

    count = lambda pred: sum(1 for r in rows if pred(r))  # noqa: E731
    return {
        "rows": rows,
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
