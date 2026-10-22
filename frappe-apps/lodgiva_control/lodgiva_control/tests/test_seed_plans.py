"""Seeding the plans and giving every existing hotel a subscription.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_seed_plans
"""

import unittest

import frappe

from lodgiva_control.patches.seed_plans import execute
from lodgiva_control.tests.test_subscription_model import (
    make_environment,
    make_subscription,
)


class TestSeedPlans(unittest.TestCase):
    def test_seeds_the_free_plan_with_its_limits(self):
        execute()
        free = frappe.get_doc("Subscription Plan", "FREE")
        self.assertEqual(free.max_users, 1)
        self.assertEqual(free.max_rooms, 10)
        self.assertEqual(free.booking_engine, 0)
        self.assertEqual(free.is_free, 1)
        self.assertEqual(free.monthly_price, 0)

    def test_paid_plans_are_seeded_disabled_without_a_price(self):
        # Their prices are not decided. A seeded number becomes a quoted price
        # the first time an operator opens the console.
        execute()
        for code in ("STARTER", "GROWTH"):
            with self.subTest(code=code):
                plan = frappe.get_doc("Subscription Plan", code)
                self.assertEqual(plan.disabled, 1)
                self.assertEqual(plan.monthly_price, 0)

    def test_is_idempotent(self):
        execute()
        execute()
        for code in ("FREE", "STARTER", "GROWTH"):
            self.assertTrue(frappe.db.exists("Subscription Plan", code))

    def test_backfills_only_hotels_without_a_subscription(self):
        existing = make_subscription(
            hotel_environment=make_environment("hasasub").name, state="active")
        bare = make_environment("needsasub")
        if frappe.db.exists("Hotel Subscription", bare.name):
            frappe.delete_doc("Hotel Subscription", bare.name,
                              force=True, ignore_permissions=True)

        execute()

        self.assertEqual(
            frappe.db.get_value("Hotel Subscription", existing.name, "state"),
            "active", "an existing subscription must not be rewritten")
        self.assertEqual(
            frappe.db.get_value("Hotel Subscription", bare.name, "state"),
            "free", "a backfilled hotel lands on free, never trialing")

    def test_backfilled_hotels_do_not_get_a_fresh_trial(self):
        # Dating a trial from the backfill would hand every current customer
        # 15 free days of paid features by accident.
        bare = make_environment("notrialplease")
        if frappe.db.exists("Hotel Subscription", bare.name):
            frappe.delete_doc("Hotel Subscription", bare.name,
                              force=True, ignore_permissions=True)
        execute()
        sub = frappe.get_doc("Hotel Subscription", bare.name)
        self.assertEqual(sub.state, "free")
        self.assertEqual(sub.plan, "FREE")
