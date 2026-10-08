"""Creating a customer's Frappe site, and the rules about what may be created.

Everything that shells out to `bench` lives here. The DocType only collects
input and enqueues; it never runs a command itself.
"""

import json
import os
import re
import secrets
import subprocess

import frappe

# A subdomain becomes a hostname, a site directory name and a TLS certificate
# subject, so it is restricted to what is safe in all three.
SUBDOMAIN_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")

# Names that must keep pointing at Lodgiva rather than at a customer.
RESERVED_SUBDOMAINS = frozenset(
    {"www", "api", "admin", "control", "app", "assets", "files"}
)

PROVISION_TIMEOUT = 45 * 60


def apex() -> str:
    """The domain customer sites hang off, e.g. "lodgiva.app".

    Site config rather than a constant: the same app serves staging and
    production, and the value is not known at build time.
    """
    value = frappe.conf.get("lodgiva_apex")
    if not value:
        frappe.throw(
            "lodgiva_apex is not set. Run: "
            "bench --site <control site> set-config lodgiva_apex <domain>"
        )
    return value


def site_name(subdomain: str) -> str:
    return f"{subdomain}.{apex()}"


def validate_subdomain(subdomain: str) -> None:
    """Raise unless `subdomain` is a shape we are willing to turn into a site."""
    if not subdomain or not SUBDOMAIN_PATTERN.match(subdomain):
        frappe.throw(
            "Subdomain must be 3-32 characters of lowercase letters, digits or "
            "hyphens, and may not start or end with a hyphen."
        )
    if subdomain in RESERVED_SUBDOMAINS:
        frappe.throw(f"'{subdomain}' is reserved.")


def site_exists(site: str) -> bool:
    return os.path.isdir(os.path.join(frappe.utils.get_bench_path(), "sites", site))


def _db_root_password() -> str:
    password = os.environ.get("DB_PASSWORD")
    if not password:
        # Worth failing loudly before the first bench call: without this, step 3
        # prompts for a password on a stdin nobody is attached to and hangs.
        frappe.throw(
            "DB_PASSWORD is not in this worker's environment, so no site can be "
            "created. Pass it through the compose override."
        )
    return password


def _redact(text: str, secrets_to_hide: list[str]) -> str:
    """Strip secrets from anything before it reaches the log field.

    Applied to command output as well as to the command line: `bench` echoes
    its arguments on some failures, so the password reaches stderr too.
    """
    for secret in secrets_to_hide:
        if secret:
            text = text.replace(secret, "********")
    return text


def _log(doc, message: str) -> None:
    doc.db_set(
        "provision_log",
        f"{doc.provision_log or ''}{message}\n",
        update_modified=False,
    )
    frappe.db.commit()


def _run(doc, args: list[str], hide: list[str]) -> None:
    """Run one bench command, streaming a redacted record of it into the doc."""
    _log(doc, f"$ {_redact(' '.join(args), hide)}")
    result = subprocess.run(
        args,
        cwd=frappe.utils.get_bench_path(),
        capture_output=True,
        text=True,
        timeout=PROVISION_TIMEOUT,
    )
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if output:
        _log(doc, _redact(output, hide))
    if result.returncode != 0:
        raise RuntimeError(f"exit {result.returncode}")


def setup_property_payload(doc) -> str:
    """Build the argument for kamra.api.setup_property from the form."""
    return json.dumps(
        {
            "payload": {
                "property": {
                    "property_name": doc.property_name,
                    "city": doc.city,
                    "state": doc.state,
                    "country": doc.country,
                    "currency": doc.currency,
                },
                "room_types": [
                    {
                        "code": row.code,
                        "name": row.room_type_name,
                        "base_price": row.base_price,
                        "adults": row.adults,
                    }
                    for row in doc.room_types
                ],
                "rooms": [
                    {
                        "room_type_code": row.room_type_code,
                        "numbers": [n.strip() for n in (row.numbers or "").split(",") if n.strip()],
                    }
                    for row in doc.room_blocks
                ],
            }
        }
    )


def provision(docname: str) -> None:
    """Create the customer's site. Enqueued; never called in a request path."""
    doc = frappe.get_doc("Hotel Environment", docname)
    site = doc.site_name

    try:
        # Refusing here is what makes a retry safe: a live customer's site can
        # never be half-overwritten by resubmitting a failed record.
        if site_exists(site):
            raise RuntimeError(f"sites/{site} already exists; clean it up before retrying")

        root_password = _db_root_password()
        admin_password = secrets.token_urlsafe(18)
        hide = [root_password, admin_password]

        doc.db_set("status", "Provisioning")
        frappe.db.commit()

        _run(doc, [
            "bench", "new-site", site,
            "--mariadb-user-host-login-scope=%",
            "--db-root-password", root_password,
            "--admin-password", admin_password,
            "--install-app", "payments",
            "--install-app", "kamra",
            "--install-app", "lodgiva_nigeria",
        ], hide)

        _run(doc, ["bench", "--site", site, "set-config", "host_name", f"https://{site}"], hide)
        _run(doc, ["bench", "--site", site, "enable-scheduler"], hide)
        _run(doc, [
            "bench", "--site", site, "execute", "kamra.api.setup_property",
            "--kwargs", setup_property_payload(doc),
        ], hide)

        doc.db_set("admin_password", admin_password)
        doc.db_set("status", "Active")
        frappe.db.commit()

    except Exception as exc:
        # Deliberately no rollback: a half-created site is left on disk to be
        # inspected and removed by hand. Dropping databases unattended is not
        # worth automating for a case this rare.
        _log(doc, f"FAILED: {exc}")
        doc.db_set("status", "Failed")
        frappe.db.commit()
        raise
