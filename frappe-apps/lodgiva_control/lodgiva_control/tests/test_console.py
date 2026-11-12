"""The console's issue rules, in isolation.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_console
"""

import unittest

from lodgiva_control.console import issues_for

TODAY = "2026-11-12"
HEALTHY = {"users": 3, "last_login": "2026-11-11 09:00:00", "rooms": 12, "properties": 1,
           "business_date": "2026-11-12", "errors_7d": 0, "scheduler_off": False,
           "access_mode": "full", "overdue": 0}


def row(**kw):
    base = {"registered": True, "on_disk": True, "status": "Active",
            "subscription": {"state": "active", "access_mode": "full"}, "health": dict(HEALTHY)}
    base.update(kw)
    return base


def texts(r):
    return [(i["level"], i["text"]) for i in issues_for(r, today=TODAY)]


class TestIssues(unittest.TestCase):
    def test_healthy_hotel_has_nothing_to_do(self):
        self.assertEqual(texts(row()), [])

    def test_unregistered_site_is_flagged(self):
        out = texts(row(registered=False, status="Unregistered", subscription=None))
        self.assertTrue(any("no Hotel Environment record" in t for _, t in out))

    def test_failed_provision_is_critical_and_first(self):
        out = texts(row(status="Failed", on_disk=False, health=None, subscription=None))
        self.assertEqual(out[0][0], "critical")
        self.assertIn("Provisioning failed", out[0][1])

    def test_stale_trial_means_sweep_not_running(self):
        out = texts(row(subscription={"state": "trialing", "trial_ends_on": "2026-11-10"}))
        self.assertTrue(any("sweep has not run" in t for _, t in out))

    def test_business_date_behind(self):
        h = dict(HEALTHY, business_date="2026-10-30", overdue=2)
        out = texts(row(health=h))
        self.assertTrue(any("13 days behind" in t for _, t in out))
        self.assertTrue(any("2 guest(s) past departure" in t for _, t in out))

    def test_unreachable_site_is_critical(self):
        out = texts(row(health={"error": "OperationalError: Unknown database"}))
        self.assertEqual(out[0][0], "critical")

    def test_active_without_subscription(self):
        out = texts(row(subscription=None))
        self.assertTrue(any("never billed" in t for _, t in out))

    def test_ordering_worst_first(self):
        h = dict(HEALTHY, scheduler_off=True, overdue=1)
        levels = [lv for lv, _ in texts(row(health=h))]
        self.assertEqual(levels, sorted(levels, key=["critical", "warning", "info"].index))
