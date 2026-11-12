"""Checks on the two functions that decide what the outside world may create.

Run with: bench --site <control site> run-tests --app lodgiva_control
"""

import os
import unittest

import frappe

from lodgiva_control.api import _is_served
from lodgiva_control.provisioning import RESERVED_SUBDOMAINS, validate_subdomain


class TestValidateSubdomain(unittest.TestCase):
    def test_accepts_ordinary_names(self):
        for value in ("grandpalm", "ikeja-suites", "hotel24", "a1b"):
            with self.subTest(value=value):
                validate_subdomain(value)  # must not raise

    def test_rejects_bad_shapes(self):
        cases = {
            "": "empty",
            "ab": "too short",
            "a" * 33: "too long",
            "-leading": "leading hyphen",
            "trailing-": "trailing hyphen",
            "Upper": "uppercase",
            "has space": "space",
            "has_underscore": "underscore",
            "dots.inside": "dot would split the hostname",
            "../etc": "path traversal",
        }
        for value, reason in cases.items():
            with self.subTest(reason=reason):
                with self.assertRaises(frappe.ValidationError):
                    validate_subdomain(value)

    def test_rejects_every_reserved_name(self):
        for value in RESERVED_SUBDOMAINS:
            with self.subTest(value=value):
                with self.assertRaises(frappe.ValidationError):
                    validate_subdomain(value)


class TestCertificateGate(unittest.TestCase):
    """_is_served decides whether Caddy may obtain a certificate.

    A false positive here lets a stranger burn the weekly Let's Encrypt quota
    for the whole domain, so the refusals matter more than the acceptance.
    """

    def test_allows_a_real_site(self):
        self.assertTrue(_is_served(frappe.local.site))

    def test_refuses_unknown_host(self):
        self.assertFalse(_is_served("not-a-customer.example.com"))

    def test_refuses_empty(self):
        self.assertFalse(_is_served(""))

    def test_refuses_traversal(self):
        # Each of these resolves to a directory that does exist, so only the
        # shape check stops them.
        for value in ("..", ".", "../sites", "../../etc", "foo/../bar"):
            with self.subTest(value=value):
                self.assertFalse(_is_served(value))

    def test_refuses_absolute_path(self):
        self.assertFalse(_is_served(os.path.join(frappe.utils.get_bench_path(), "sites")))

    def test_refuses_null_byte(self):
        self.assertFalse(_is_served("site\x00.com"))
