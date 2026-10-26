"""Where the control app is allowed to live.

The control plane must not be subject to the billing state it enforces. While
lodgiva_control rides on a hotel site, that hotel going unpaid takes the
console that manages billing read-only with it.

Run on BOTH sites:
    bench --site kamra.localhost    run-tests --app lodgiva_control \
        --module lodgiva_control.tests.test_control_site
    bench --site control.localhost  run-tests --app lodgiva_control \
        --module lodgiva_control.tests.test_control_site
"""

import unittest

import frappe


def is_control_site() -> bool:
    return (frappe.local.site or "").startswith("control.")


class TestControlSiteIsolation(unittest.TestCase):
    def test_control_app_lives_only_on_the_control_site(self):
        installed = frappe.get_installed_apps()
        if is_control_site():
            self.assertIn("lodgiva_control", installed)
        else:
            self.assertNotIn(
                "lodgiva_control", installed,
                "the control app must not run on a hotel site: that hotel "
                "going unpaid would restrict the billing console itself")

    def test_control_site_is_never_access_restricted(self):
        if not is_control_site():
            self.skipTest("only meaningful on the control site")
        self.assertIsNone(
            frappe.conf.get("lodgiva_access_mode"),
            "the sweep must never write an access mode onto the control site")

    def test_control_site_knows_where_hotels_live(self):
        if not is_control_site():
            self.skipTest("only meaningful on the control site")
        self.assertTrue(frappe.conf.get("lodgiva_apex"),
                        "lodgiva_apex must be set for site names to resolve")
