"""The subscription state machine.

Every decision about what state a subscription should be in is made here, and
nowhere else. The functions below take no clock and touch no database: the
caller supplies today's date and the age of the suspension notice, and gets
back a state. That is what makes the whole transition table testable in
milliseconds, and it is why a record dated in the future is as easy to reason
about as one that expired last week.

The spec's two rules, and only these two, move a subscription:

1. A trial that has ended falls back to the free tier.
2. Grace that has expired restricts - but only once notice has been served.

Everything else stays where it is. A state machine that moves a record for
reasons not written down here is a state machine nobody can predict.
"""

from __future__ import annotations

from datetime import date

import frappe
from frappe.utils import add_days, nowdate

#: Minimum age of a suspension notice before a subscription may be restricted.
NOTICE_HOURS = 72

#: Grace period bounds, in days. The spec fixes 7-14 with a default of 14.
GRACE_MIN = 7
GRACE_MAX = 14
GRACE_DEFAULT = 14

#: States whose access is full regardless of usage.
FULL_ACCESS_STATES = frozenset({"trialing", "active", "past_due"})

#: States that restrict unconditionally.
RESTRICTED_STATES = frozenset({"unpaid", "cancelled", "paused"})

#: Legal transitions. Anything not listed here is a bug, not a feature.
TRANSITIONS: dict[str, set[str]] = {
    "trialing": {"active", "free", "cancelled", "paused"},
    "active": {"past_due", "cancelled", "paused"},
    "past_due": {"active", "unpaid", "cancelled", "paused"},
    "unpaid": {"active", "cancelled", "paused"},
    "free": {"active", "cancelled", "paused"},
    "cancelled": {"active"},
    "paused": {"active", "cancelled"},
}


def grace_days(raw) -> int:
    """Grace period in days, clamped to the spec's 7-14 window.

    Anything unusable - absent, a string, a float, nonsense - becomes the
    default rather than raising. This runs inside a scheduled job, where an
    exception means every hotel after this one goes unevaluated.
    """
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return GRACE_DEFAULT
    return max(GRACE_MIN, min(GRACE_MAX, value))


def next_state(
    current: dict,
    today: date,
    notice_age_hours: float | None,
) -> tuple[str, str]:
    """The state this subscription should be in, and why.

    `current` carries `state`, `plan_is_free`, and whichever of
    `trial_ends_on` / `grace_ends_on` the state needs. `notice_age_hours` is
    how long ago the suspension notice was sent, or None if it never was.

    Returns `(state, reason)`. The reason is a short sentence written into
    state_log, so that when a hotel asks why it was restricted the answer is
    on the record rather than in somebody's memory.
    """
    state = current.get("state") or "trialing"

    if state == "trialing":
        ends = current.get("trial_ends_on")
        if ends and ends < today:
            return "free", "trial ended; fell back to the free tier"
        return state, "trial still running"

    if state == "past_due":
        grace_ends = current.get("grace_ends_on")
        if not grace_ends or grace_ends >= today:
            return state, "inside grace period"

        if notice_age_hours is None:
            return state, "grace expired but no suspension notice has been sent"
        if notice_age_hours < NOTICE_HOURS:
            return state, (
                f"grace expired; notice is {notice_age_hours:.0f}h old, "
                f"{NOTICE_HOURS}h required"
            )
        return "unpaid", "grace expired and notice served"

    return state, "no rule applies"


def access_mode_for(state: str, usage: dict, limits: dict) -> str:
    """Whether this hotel may write, given its state and what it is using.

    Usage only ever restricts the free tier. A paying hotel that exceeds a
    limit is an upsell conversation, not a lockout - and `past_due` keeps full
    access on purpose: the card failed, the hotel did nothing wrong.
    """
    if state in RESTRICTED_STATES:
        return "read_only"

    if state in FULL_ACCESS_STATES:
        return "full"

    if state == "free":
        if _over_limit(usage.get("users", 0), limits.get("max_users", 0)):
            return "read_only"
        if _over_limit(usage.get("rooms", 0), limits.get("max_rooms", 0)):
            return "read_only"
        return "full"

    # An unknown state is not a reason to lock a hotel out of its own data.
    return "full"


def _over_limit(used: int, cap: int) -> bool:
    """0 means unlimited, which is why this is not a bare `used > cap`."""
    return bool(cap) and used > cap


@frappe.whitelist()
def mark_payment_succeeded(subscription: str) -> str:
    """Payment cleared. Back to active, grace and notice wiped.

    Called by the billing integration (sub-project #3). Nothing here knows a
    payment processor exists.
    """
    doc = frappe.get_doc("Hotel Subscription", subscription)
    doc.check_permission("write")

    doc.db_set("state", "active")
    doc.db_set("grace_ends_on", None)
    doc.db_set("suspend_notice_sent_on", None)
    doc.log("payment succeeded; state -> active")
    frappe.db.commit()
    return "active"


@frappe.whitelist()
def mark_payment_failed(subscription: str) -> str:
    """Payment failed. Starts grace, but never restricts immediately.

    Only a subscription that was paying can fall into arrears. One that is
    already `unpaid` or `cancelled` is left alone: a second failed charge is
    not a reason to deepen a state the customer is already in.
    """
    doc = frappe.get_doc("Hotel Subscription", subscription)
    doc.check_permission("write")

    if doc.state not in ("active", "trialing"):
        return doc.state

    days = grace_days(frappe.conf.get("lodgiva_grace_days"))
    doc.db_set("state", "past_due")
    doc.db_set("grace_ends_on", add_days(nowdate(), days))
    doc.log(f"payment failed; state -> past_due, grace {days} days")
    frappe.db.commit()
    return "past_due"
