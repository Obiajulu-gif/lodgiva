"""The state machine, in isolation.

next_state takes no clock and touches no database, so the whole transition
table runs in milliseconds and a future-dated record is as easy to test as
an expired one.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_subscription_state
"""

import unittest
from datetime import date

from lodgiva_control.subscription import grace_days, next_state


class TestNextState(unittest.TestCase):
    def test_trial_expiry_drops_to_free(self):
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "free")

    def test_trial_not_yet_over_stays_trialing(self):
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2026, 1, 5), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "trialing")

    def test_future_dated_trial_does_not_transition(self):
        # Review Focus 3: a manual edit must not drive a transition.
        state, _ = next_state(
            {"state": "trialing", "trial_ends_on": date(2027, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 2), notice_age_hours=None)
        self.assertEqual(state, "trialing")

    def test_past_due_without_notice_stays_past_due(self):
        state, reason = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=None)
        self.assertEqual(state, "past_due")
        self.assertIn("notice", reason.lower())

    def test_past_due_with_stale_notice_stays_past_due(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=71.0)
        self.assertEqual(state, "past_due")

    def test_past_due_with_served_notice_becomes_unpaid(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 1, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=73.0)
        self.assertEqual(state, "unpaid")

    def test_past_due_inside_grace_never_restricts(self):
        state, _ = next_state(
            {"state": "past_due", "grace_ends_on": date(2026, 2, 1), "plan_is_free": False},
            today=date(2026, 1, 20), notice_age_hours=500.0)
        self.assertEqual(state, "past_due")

    def test_terminal_states_do_not_move(self):
        for terminal in ("cancelled", "paused", "free", "active"):
            with self.subTest(state=terminal):
                state, _ = next_state(
                    {"state": terminal, "plan_is_free": terminal == "free"},
                    today=date(2026, 6, 1), notice_age_hours=None)
                self.assertEqual(state, terminal)


class TestGraceDays(unittest.TestCase):
    def test_clamps_and_defaults(self):
        # Review Focus 4: a scheduled job must not raise on bad config.
        self.assertEqual(grace_days(3), 7)
        self.assertEqual(grace_days(30), 14)
        self.assertEqual(grace_days(10), 10)
        self.assertEqual(grace_days(None), 14)
        self.assertEqual(grace_days("banana"), 14)
