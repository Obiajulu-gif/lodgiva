"""The two entry points the billing integration will call.

Nothing here contacts a payment processor or knows a retry schedule exists.
Sub-project #3 owns that; these are the seams it plugs into.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_payment_seams
"""

import unittest

import frappe
from frappe.utils import add_days, nowdate

from lodgiva_control.subscription import mark_payment_failed, mark_payment_succeeded
from lodgiva_control.tests.test_subscription_model import (
    make_environment,
    make_subscription,
)


class TestPaymentSeams(unittest.TestCase):
    def test_success_from_any_restricted_state_restores_active(self):
        for start in ("past_due", "unpaid", "free"):
            with self.subTest(start=start):
                # Subdomains allow no underscores, so past_due -> pastdue.
                sub = make_subscription(
                    hotel_environment=make_environment(f"pay{start.replace('_', '')}").name,
                    state=start,
                    grace_ends_on=nowdate(),
                )
                self.assertEqual(mark_payment_succeeded(sub.name), "active")
                sub.reload()
                self.assertEqual(sub.state, "active")
                self.assertIsNone(sub.grace_ends_on)
                self.assertIsNone(sub.suspend_notice_sent_on)

    def test_failure_from_active_starts_grace(self):
        sub = make_subscription(
            hotel_environment=make_environment("failactive").name, state="active")
        self.assertEqual(mark_payment_failed(sub.name), "past_due")
        sub.reload()
        self.assertEqual(str(sub.grace_ends_on), add_days(nowdate(), 14))

    def test_failure_does_not_deepen_an_already_unpaid_subscription(self):
        sub = make_subscription(
            hotel_environment=make_environment("failunpaid").name, state="unpaid")
        self.assertEqual(mark_payment_failed(sub.name), "unpaid")
        sub.reload()
        self.assertEqual(sub.state, "unpaid")

    def test_failure_never_restricts_immediately(self):
        sub = make_subscription(
            hotel_environment=make_environment("failnow").name, state="active")
        mark_payment_failed(sub.name)
        sub.reload()
        self.assertEqual(sub.access_mode, "full")

    def test_both_seams_are_whitelisted(self):
        # The billing integration calls these over the API, not in-process.
        # frappe.whitelisted holds the actual function objects.
        for fn in (mark_payment_succeeded, mark_payment_failed):
            with self.subTest(fn=fn.__name__):
                self.assertIn(fn, frappe.whitelisted)

    def test_transitions_are_written_to_the_log(self):
        sub = make_subscription(
            hotel_environment=make_environment("paylog").name, state="active")
        mark_payment_failed(sub.name)
        sub.reload()
        self.assertIn("past_due", sub.state_log)
        mark_payment_succeeded(sub.name)
        sub.reload()
        self.assertIn("active", sub.state_log)
