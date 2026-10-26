"""What a given state and usage mean for a hotel's ability to write.

Run with: bench --site <control site> run-tests --app lodgiva_control \
    --module lodgiva_control.tests.test_access_mode
"""

import unittest

from lodgiva_control.subscription import access_mode_for


class TestAccessMode(unittest.TestCase):
    UNLIMITED = {"max_users": 0, "max_rooms": 0}
    FREE = {"max_users": 1, "max_rooms": 10}

    def test_full_access_states(self):
        for state in ("trialing", "active", "past_due"):
            with self.subTest(state=state):
                self.assertEqual(
                    access_mode_for(state, {"users": 50, "rooms": 500}, self.UNLIMITED),
                    "full")

    def test_past_due_keeps_full_access(self):
        self.assertEqual(
            access_mode_for("past_due", {"users": 1, "rooms": 1}, self.UNLIMITED), "full")

    def test_restricted_states(self):
        for state in ("unpaid", "cancelled", "paused"):
            with self.subTest(state=state):
                self.assertEqual(
                    access_mode_for(state, {"users": 1, "rooms": 1}, self.UNLIMITED),
                    "read_only")

    def test_free_within_limits_is_full(self):
        self.assertEqual(
            access_mode_for("free", {"users": 1, "rooms": 10}, self.FREE), "full")

    def test_free_over_limits_matches_unpaid(self):
        over = access_mode_for("free", {"users": 1, "rooms": 11}, self.FREE)
        self.assertEqual(over, "read_only")
        self.assertEqual(
            over, access_mode_for("unpaid", {"users": 1, "rooms": 1}, self.FREE))

    def test_free_hotel_that_shrinks_returns_to_full(self):
        # Review Focus 5: restriction is recomputed every sweep, never latched.
        self.assertEqual(
            access_mode_for("free", {"users": 1, "rooms": 11}, self.FREE), "read_only")
        self.assertEqual(
            access_mode_for("free", {"users": 1, "rooms": 9}, self.FREE), "full")

    def test_zero_means_unlimited(self):
        self.assertEqual(
            access_mode_for("free", {"users": 99, "rooms": 99}, self.UNLIMITED), "full")
