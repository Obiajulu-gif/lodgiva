"""The two DocTypes a subscription is made of.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_subscription_model
"""

import unittest

import frappe
from frappe.utils import add_days, nowdate

PLAN_CODE = "TEST-STARTER"


def make_plan(plan_code=PLAN_CODE, is_free=0, **kwargs):
    if frappe.db.exists("Subscription Plan", plan_code):
        return frappe.get_doc("Subscription Plan", plan_code)
    doc = frappe.get_doc({
        "doctype": "Subscription Plan",
        "plan_code": plan_code,
        "plan_name": kwargs.get("plan_name", plan_code.title()),
        "monthly_price": kwargs.get("monthly_price", 50000),
        "max_users": kwargs.get("max_users", 0),
        "max_rooms": kwargs.get("max_rooms", 0),
        "allowed_modules": kwargs.get("allowed_modules", ""),
        "booking_engine": kwargs.get("booking_engine", 1),
        "is_free": is_free,
    })
    doc.insert(ignore_permissions=True)
    return doc


def make_environment(subdomain):
    name = subdomain
    if frappe.db.exists("Hotel Environment", name):
        return frappe.get_doc("Hotel Environment", name)
    doc = frappe.get_doc({
        "doctype": "Hotel Environment",
        "customer_name": f"{subdomain} Ltd",
        "subdomain": subdomain,
        "owner_email": f"{subdomain}@example.test",
        "property_name": f"{subdomain} Hotel",
        "city": "Lagos",
        "country": "Nigeria",
        "currency": "NGN",
        "room_types": [{"code": "STD", "room_type_name": "Standard",
                        "base_price": 40000, "adults": 2}],
        "room_blocks": [{"room_type_code": "STD", "numbers": "101, 102"}],
    })
    doc.insert(ignore_permissions=True)
    return doc


def make_subscription(hotel_environment=None, plan=PLAN_CODE, **kwargs):
    make_plan(plan)
    if hotel_environment is None:
        hotel_environment = make_environment(frappe.generate_hash(length=8).lower()).name
    doc = frappe.get_doc({
        "doctype": "Hotel Subscription",
        "hotel_environment": hotel_environment,
        "plan": plan,
        **kwargs,
    })
    doc.insert(ignore_permissions=True)
    return doc


class TestSubscriptionModel(unittest.TestCase):
    def test_trial_ends_fifteen_days_after_creation(self):
        sub = make_subscription(plan=PLAN_CODE)
        self.assertEqual(str(sub.trial_ends_on), add_days(nowdate(), 15))
        self.assertEqual(sub.state, "trialing")
        self.assertEqual(sub.access_mode, "full")

    def test_one_subscription_per_hotel(self):
        env = make_environment("dupe")
        make_subscription(hotel_environment=env.name)
        with self.assertRaises(frappe.exceptions.DuplicateEntryError):
            make_subscription(hotel_environment=env.name)

    def test_exactly_one_plan_is_free(self):
        make_plan("TEST-FREE1", is_free=1)
        with self.assertRaises(frappe.ValidationError):
            make_plan("TEST-FREE2", is_free=1)
