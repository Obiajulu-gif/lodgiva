"""The daily sweep: compute every subscription's state, push the result out.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_sweep
"""

import unittest
from contextlib import contextmanager
from unittest.mock import patch

import frappe
from frappe.utils import add_days, nowdate

from lodgiva_control import scheduler
from lodgiva_control.scheduler import evaluate_subscriptions
from lodgiva_control.tests.test_subscription_model import (
    make_environment,
    make_subscription,
)


@contextmanager
def write_fails_for(site: str):
    """Make write_access_mode blow up for one site and work for the rest."""
    real = scheduler.write_access_mode

    def fake(target, mode):
        if target == site:
            raise RuntimeError(f"bench set-config failed for {target}")
        return real(target, mode)

    with patch.object(scheduler, "write_access_mode", side_effect=fake):
        yield


@contextmanager
def mail_works():
    """Stand in for a mail server.

    The sweep refuses to stamp suspend_notice_sent_on when sending fails, so
    without this the notice tests would be testing Frappe's mail config rather
    than the sweep's logic.
    """
    with patch("frappe.sendmail", return_value=None):
        yield


@contextmanager
def mail_fails():
    with patch("frappe.sendmail", side_effect=RuntimeError("no outgoing account")):
        yield


@contextmanager
def writes_recorded():
    """Capture what the sweep would push, without shelling out to bench."""
    seen = {}

    def fake(target, mode):
        seen[target] = mode

    with patch.object(scheduler, "write_access_mode", side_effect=fake):
        yield seen


class TestSweep(unittest.TestCase):
    def test_hotel_without_subscription_is_skipped_not_restricted(self):
        # Review Focus 1: hotels predating this feature must survive untouched.
        env = make_environment("nosub")
        with writes_recorded() as seen:
            result = evaluate_subscriptions()
        self.assertNotIn(env.site_name, result["failed"])
        self.assertNotIn(env.site_name, seen)
        self.assertFalse(
            frappe.db.exists("Hotel Subscription", {"hotel_environment": env.name}))

    def test_one_failing_site_does_not_stop_the_sweep(self):
        # Review Focus 2: a dropped site must not strand every hotel after it.
        gone = make_subscription(hotel_environment=make_environment("gone").name)
        good = make_subscription(hotel_environment=make_environment("fine").name)
        with write_fails_for("gone.localhost"):
            result = evaluate_subscriptions()
        self.assertIn("gone.localhost", result["failed"])
        self.assertEqual(
            frappe.db.get_value("Hotel Subscription", good.name, "access_mode"), "full")

    def test_transition_is_recorded_in_state_log(self):
        sub = make_subscription(
            hotel_environment=make_environment("expired").name,
            trial_ends_on=add_days(nowdate(), -1),
        )
        with writes_recorded():
            evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.state, "free")
        self.assertIn("free", sub.state_log)

    def test_grace_expiry_without_notice_sends_one_and_waits(self):
        sub = make_subscription(
            hotel_environment=make_environment("noticeme").name,
            state="past_due",
            grace_ends_on=add_days(nowdate(), -1),
        )
        with writes_recorded(), mail_works():
            result = evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.state, "past_due", "notice must precede restriction")
        self.assertIsNotNone(sub.suspend_notice_sent_on)
        self.assertGreaterEqual(result["noticed"], 1)

    def test_unsendable_notice_does_not_count_as_served(self):
        """A notice that could not be sent must not unlock restriction.

        Stamping on a failed send would restrict a hotel that was never told,
        which is exactly what the 72-hour rule exists to prevent.
        """
        sub = make_subscription(
            hotel_environment=make_environment("mailbroke").name,
            state="past_due",
            grace_ends_on=add_days(nowdate(), -1),
        )
        with writes_recorded(), mail_fails():
            evaluate_subscriptions()
        sub.reload()
        self.assertIsNone(sub.suspend_notice_sent_on)
        self.assertEqual(sub.state, "past_due")

    def test_notice_is_sent_once_not_every_sweep(self):
        sub = make_subscription(
            hotel_environment=make_environment("onenotice").name,
            state="past_due",
            grace_ends_on=add_days(nowdate(), -1),
        )
        with writes_recorded(), mail_works():
            evaluate_subscriptions()
        sub.reload()
        first = sub.suspend_notice_sent_on
        self.assertIsNotNone(first)
        with writes_recorded(), mail_works():
            evaluate_subscriptions()
        sub.reload()
        self.assertEqual(sub.suspend_notice_sent_on, first)

    def test_sweep_never_deletes_rows(self):
        make_subscription(hotel_environment=make_environment("keepme").name)
        before = {
            dt: frappe.db.count(dt)
            for dt in ("Hotel Environment", "Hotel Subscription", "Subscription Plan")
        }
        with writes_recorded():
            evaluate_subscriptions()
        for dt, count in before.items():
            self.assertEqual(frappe.db.count(dt), count, f"{dt} lost rows")
