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


class TestExceptions(unittest.TestCase):
    NOW = "2026-11-12 12:00:00"

    def kinds(self, r):
        from lodgiva_control.console import exceptions_for
        return {e["kind"]: e for e in exceptions_for(r, now=self.NOW)}

    def active(self, **kw):
        h = dict(HEALTHY, last_job="2026-11-12 11:30:00")
        base = row(health=h, name="h1", site_name="h1.example",
                   backups={"Off-site copy": {"at": "2026-11-12 02:00:00"}})
        base.update(kw)
        return base

    def test_healthy_site_has_no_exceptions(self):
        self.assertEqual(self.kinds(self.active()), {})

    def test_failed_provision_offers_retry(self):
        e = self.kinds(row(status="Failed", name="h1", site_name="h1.example", on_disk=False,
                           health=None, modified="2026-11-12 10:00:00"))["provisioning"]
        self.assertEqual(e["action"]["act"], "retry")
        self.assertEqual(e["when"], "2026-11-12 10:00:00")

    def test_stale_and_missing_offsite_backup(self):
        stale = self.active(backups={"Off-site copy": {"at": "2026-11-10 02:00:00"}})
        self.assertIn("58 hours", self.kinds(stale)["backup"]["what"])
        self.assertIn("on record", self.kinds(self.active(backups={}))["backup"]["what"])

    def test_missed_jobs(self):
        h = dict(HEALTHY, last_job="2026-11-12 07:00:00")
        self.assertIn("scheduler process is down", self.kinds(self.active(health=h))["jobs"]["what"])

    def test_overdue_subscription_and_access_mismatch(self):
        sub = {"name": "S1", "state": "past_due", "grace_ends_on": "2026-11-15", "access_mode": "read_only"}
        from lodgiva_control.console import exceptions_for
        subs = [e for e in exceptions_for(self.active(subscription=sub), now=self.NOW)
                if e["kind"] == "subscription"]
        overdue = [e for e in subs if e["what"].startswith("Subscription past due")]
        self.assertEqual(overdue[0]["action"]["act"], "paid")
        self.assertIn("2026-11-15", overdue[0]["what"])
        # the site still applies "full" while the subscription says read_only
        self.assertEqual(len([e for e in subs if "mismatch" in e["what"]]), 1)
