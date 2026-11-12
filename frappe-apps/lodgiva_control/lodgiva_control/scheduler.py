"""The daily sweep.

Walks every subscription, asks the state machine what it should be, and pushes
the resulting access mode into that hotel's site config. This is the only thing
in the system that changes a subscription's state on its own.

Two properties matter more than anything else here:

1. **A hotel with no subscription is never touched.** The loop iterates
   subscriptions, not hotels, so a site that predates this feature is simply
   absent rather than guarded against. Half the fleet is in that position.

2. **One hotel's failure does not strand the rest.** A dropped site, a full
   disk or a wedged bench raises somewhere in the middle of a sweep. Each
   hotel's work is wrapped, the failure is recorded, and the loop goes on.
   A sweep that aborts halfway leaves later hotels on yesterday's mode with
   nobody aware of it.
"""

from __future__ import annotations

import subprocess

import frappe
from frappe.utils import get_datetime, now_datetime, nowdate, getdate

from lodgiva_control import provisioning
from lodgiva_control.subscription import access_mode_for, next_state

SET_CONFIG_TIMEOUT = 120


def write_access_mode(site: str, mode: str) -> None:
    """Record the hotel's access mode where its own site can read it.

    Site config rather than a shared table or an API call: the hotel must keep
    working on its last known mode when the control plane is unreachable. A
    billing outage that locks out a hotel which has paid is worse than a
    billing outage.
    """
    result = subprocess.run(
        [provisioning.bench_bin(), "--site", site, "set-config", "lodgiva_access_mode", mode],
        cwd=frappe.utils.get_bench_path(),
        capture_output=True,
        text=True,
        timeout=SET_CONFIG_TIMEOUT,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"set-config failed for {site}: {(result.stderr or result.stdout).strip()[:200]}"
        )


def usage_for(site: str) -> dict:
    """How many users and rooms this hotel is actually using.

    Counted on the hotel's own site, which is the only place that knows. A
    site that cannot be read returns zeros rather than raising: unreadable
    usage must not restrict a hotel, only fail to lift a restriction.
    """
    script = (
        "import frappe, json\n"
        f"frappe.init(site={site!r})\n"
        "frappe.connect()\n"
        "print(json.dumps({"
        "'users': frappe.db.count('User', {'enabled': 1, 'user_type': 'System User'}), "
        "'rooms': frappe.db.count('Room')"
        "}))\n"
    )
    bench_path = frappe.utils.get_bench_path()
    result = subprocess.run(
        [f"{bench_path}/env/bin/python", "-c", script],
        cwd=f"{bench_path}/sites",
        capture_output=True,
        text=True,
        timeout=SET_CONFIG_TIMEOUT,
    )
    if result.returncode != 0:
        return {"users": 0, "rooms": 0}
    try:
        return frappe.parse_json(result.stdout.strip().splitlines()[-1])
    except Exception:
        return {"users": 0, "rooms": 0}


def send_suspension_notice(doc) -> None:
    """Warn the hotel before anything is restricted, and stamp when.

    The stamp is what the state machine reads. Restriction is impossible
    until this has been sitting on the record for 72 hours, so this function
    is the thing standing between a failed payment and a locked front desk.
    """
    owner_email = frappe.db.get_value(
        "Hotel Environment", doc.hotel_environment, "owner_email")

    if owner_email:
        try:
            frappe.sendmail(
                recipients=[owner_email],
                subject="Your Lodgiva subscription needs attention",
                message=(
                    f"<p>The subscription for <b>{doc.hotel_environment}</b> is overdue.</p>"
                    f"<p>If it is not settled, the system will become read-only in 72 hours. "
                    f"Your data stays intact, and you will still be able to check out guests "
                    f"already in the hotel.</p>"
                ),
                now=False,
            )
        except Exception as exc:
            # A mail server problem must not block the sweep, but it must not
            # silently count as notice served either - the stamp below is what
            # unlocks restriction, so it is only written when sending worked.
            doc.log(f"suspension notice could not be sent: {exc}")
            return

    doc.db_set("suspend_notice_sent_on", now_datetime())
    doc.log("suspension notice sent")


def evaluate_subscriptions() -> dict:
    """Bring every subscription up to date. Scheduled daily."""
    today = getdate(nowdate())
    result = {"evaluated": 0, "changed": 0, "noticed": 0, "failed": []}

    names = [row.name for row in frappe.get_all("Hotel Subscription", fields=["name"])]

    for name in names:
        doc = frappe.get_doc("Hotel Subscription", name)
        site = frappe.db.get_value("Hotel Environment", doc.hotel_environment, "site_name")
        result["evaluated"] += 1

        try:
            plan = frappe.get_doc("Subscription Plan", doc.plan)

            notice_age = None
            if doc.suspend_notice_sent_on:
                delta = now_datetime() - get_datetime(doc.suspend_notice_sent_on)
                notice_age = delta.total_seconds() / 3600.0

            state, reason = next_state(
                {
                    "state": doc.state,
                    "plan_is_free": bool(plan.is_free),
                    "trial_ends_on": getdate(doc.trial_ends_on) if doc.trial_ends_on else None,
                    "grace_ends_on": getdate(doc.grace_ends_on) if doc.grace_ends_on else None,
                },
                today=today,
                notice_age_hours=notice_age,
            )

            # Grace has run out but nobody has been warned: warn them now and
            # leave the state alone. The 72-hour clock starts here.
            if (
                state == "past_due"
                and doc.grace_ends_on
                and getdate(doc.grace_ends_on) < today
                and not doc.suspend_notice_sent_on
            ):
                send_suspension_notice(doc)
                doc.reload()
                if doc.suspend_notice_sent_on:
                    result["noticed"] += 1

            mode = access_mode_for(
                state,
                usage_for(site) if state == "free" else {},
                {"max_users": plan.max_users, "max_rooms": plan.max_rooms},
            )

            changed = state != doc.state or mode != doc.access_mode
            if changed:
                if state != doc.state:
                    doc.db_set("state", state)
                    doc.log(f"{doc.state} -> {state}: {reason}")
                if mode != doc.access_mode:
                    doc.db_set("access_mode", mode)
                    doc.log(f"access mode -> {mode}")
                result["changed"] += 1

            if site:
                write_access_mode(site, mode)

        except Exception as exc:
            frappe.log_error(
                title="Subscription sweep failed",
                message=f"{name} ({site}): {exc}",
            )
            result["failed"].append(site or name)

    frappe.db.commit()
    return result
