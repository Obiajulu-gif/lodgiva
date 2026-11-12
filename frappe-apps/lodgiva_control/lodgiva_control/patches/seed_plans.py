"""Seed the subscription plans and give every existing hotel a subscription.

Idempotent: existing records are left exactly as they are. Running this twice
changes nothing, which is what makes it safe in a migrate.

The FREE plan's limits come from the spec. STARTER and GROWTH are seeded
**disabled and priced at zero** on purpose: their real prices have not been
decided, and a seeded number becomes a quoted price the first time an operator
opens the console and reads it as fact.
"""

import frappe

FREE_MODULES = "front-desk,housekeeping,operations"

PLANS = [
    {
        "plan_code": "FREE",
        "plan_name": "Free",
        "monthly_price": 0,
        "max_users": 1,
        "max_rooms": 10,
        "allowed_modules": FREE_MODULES,
        "booking_engine": 0,
        "is_free": 1,
        "disabled": 0,
    },
    {
        "plan_code": "STARTER",
        "plan_name": "Starter",
        "monthly_price": 0,
        "max_users": 5,
        "max_rooms": 40,
        "allowed_modules": "",
        "booking_engine": 1,
        "is_free": 0,
        "disabled": 1,
    },
    {
        "plan_code": "GROWTH",
        "plan_name": "Growth",
        "monthly_price": 0,
        "max_users": 0,
        "max_rooms": 0,
        "allowed_modules": "",
        "booking_engine": 1,
        "is_free": 0,
        "disabled": 1,
    },
]


def execute() -> None:
    for plan in PLANS:
        if frappe.db.exists("Subscription Plan", plan["plan_code"]):
            continue
        frappe.get_doc({"doctype": "Subscription Plan", **plan}).insert(
            ignore_permissions=True)

    backfill_subscriptions()
    frappe.db.commit()


def backfill_subscriptions() -> None:
    """Give every hotel that has no subscription a free one.

    State is set explicitly to `free`, never left to the DocType's `trialing`
    default: an existing hotel has not just started a trial, and inheriting one
    here would hand every current customer 15 days of paid features nobody
    decided to give them.
    """
    subscribed = {
        row.hotel_environment
        for row in frappe.get_all("Hotel Subscription", fields=["hotel_environment"])
    }

    for row in frappe.get_all("Hotel Environment", fields=["name"]):
        if row.name in subscribed:
            continue
        doc = frappe.get_doc({
            "doctype": "Hotel Subscription",
            "hotel_environment": row.name,
            "plan": "FREE",
            "state": "free",
            "access_mode": "full",
        })
        doc.insert(ignore_permissions=True)
        doc.log("backfilled onto the free plan")
