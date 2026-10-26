"""The endpoint Caddy asks before issuing a TLS certificate.

On-demand TLS issues a certificate for whatever hostname shows up in SNI. With
no gate, anyone pointing a DNS record at this server can force issuance for
arbitrary names and exhaust the Let's Encrypt limit of 50 certificates per
registered domain per week, taking real customers offline. This endpoint is
that gate, so it answers only for hosts we actually serve.
"""

import os

import frappe


def _is_served(domain: str) -> bool:
    """True when `domain` is a site on this bench.

    Checked against the filesystem rather than the database so the answer stays
    correct while the control site is down or mid-migration — the certificate
    path must not depend on the control app being healthy.
    """
    if not domain:
        return False

    # The value arrives from the network and is about to be joined onto a path.
    # A site name is a single path segment; anything else is refused outright
    # rather than normalised, so no traversal can reach a directory that merely
    # happens to exist.
    if domain != os.path.basename(domain) or domain in (".", ".."):
        return False
    if "/" in domain or "\\" in domain or "\x00" in domain:
        return False

    sites_path = os.path.join(frappe.utils.get_bench_path(), "sites")
    return os.path.isdir(os.path.join(sites_path, domain))


@frappe.whitelist(allow_guest=True, methods=["GET"])
def allow_host(domain: str | None = None) -> str:
    """Answer 200 when Caddy may issue for `domain`, 404 when it may not.

    Caddy treats any 2xx as permission and everything else as refusal.
    """
    if _is_served(domain or ""):
        return "ok"

    frappe.local.response["http_status_code"] = 404
    return "unknown host"
