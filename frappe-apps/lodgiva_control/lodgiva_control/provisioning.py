"""Creating a customer's Frappe site, and the rules about what may be created.

Everything that shells out to `bench` lives here. The DocType only collects
input and enqueues; it never runs a command itself.
"""

import json
import os
import re
import secrets
import shutil
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


def bench_bin() -> str:
    """Absolute path to the bench executable.

    A background worker does not inherit the login shell's PATH, so plain
    "bench" raises FileNotFoundError inside the job even though it resolves
    fine in a terminal. Resolve it once, explicitly.
    """
    configured = frappe.conf.get("lodgiva_bench_bin")
    if configured and os.path.exists(configured):
        return configured

    found = shutil.which("bench")
    if found:
        return found

    for candidate in (
        os.path.expanduser("~/.local/bin/bench"),
        "/usr/local/bin/bench",
        "/home/frappe/.local/bin/bench",
    ):
        if os.path.exists(candidate):
            return candidate

    frappe.throw(
        "Could not find the bench executable. Set lodgiva_bench_bin in the "
        "control site's config to its absolute path."
    )


def db_settings() -> dict:
    """Where new sites' databases are created, and who may create them.

    Three sources, in order, so the same code provisions on the Docker server
    and on a developer bench without either one being a special case:

    1. site config (`lodgiva_db_*`) - explicit, and the only option that works
       when the database is not where the bench's own config points,
    2. `DB_PASSWORD` in the environment - how frappe_docker supplies it,
    3. the bench's own `db_host`/`db_port`, for the ordinary single-host case.

    Failing here is deliberate and early: without a password `bench new-site`
    prompts on a stdin nobody is attached to, and the job hangs instead of
    reporting anything useful.
    """
    conf = frappe.conf
    password = conf.get("lodgiva_db_root_password") or os.environ.get("DB_PASSWORD")
    if not password:
        frappe.throw(
            "No database root password available. Set lodgiva_db_root_password "
            "in the control site's config, or pass DB_PASSWORD in the worker's "
            "environment."
        )
    return {
        "user": conf.get("lodgiva_db_root_user") or "root",
        "password": password,
        "host": conf.get("lodgiva_db_host") or conf.get("db_host") or "127.0.0.1",
        "port": str(conf.get("lodgiva_db_port") or conf.get("db_port") or 3306),
    }


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


SECRET_LINE = re.compile(r"^ACTIVATE.*$", re.M)


def _run(doc, args: list[str], hide: list[str], cwd: str | None = None) -> str:
    """Run one bench command, streaming a redacted record of it into the doc.

    Returns the raw output. Lines starting ACTIVATE carry the owner's
    activation link: returned to the caller, never written to the log.
    """
    _log(doc, f"$ {_redact(' '.join(args), hide)}")
    result = subprocess.run(
        args,
        cwd=cwd or frappe.utils.get_bench_path(),
        capture_output=True,
        text=True,
        timeout=PROVISION_TIMEOUT,
    )
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    if output:
        _log(doc, _redact(SECRET_LINE.sub("ACTIVATE <link withheld>", output), hide))
    if result.returncode != 0:
        raise RuntimeError(f"exit {result.returncode}")
    return output


# What the owner gets on their own hotel's site. Unrestricted (no Property
# User Permission), so a group owner sees every property they add later.
OWNER_ROLES = ("Hotel Admin", "Front Desk", "Housekeeping", "Finance", "Revenue Manager")

OWNER_SCRIPT = """
import frappe, sys
site, email, full_name, roles = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
frappe.init(site=site)
frappe.connect()
# Two days to act on the activation email, not Frappe's 20 minutes.
frappe.db.set_single_value("System Settings", "reset_password_link_expiry_duration", 172800)
for r in roles:
    if not frappe.db.exists("Role", r):
        frappe.get_doc({"doctype": "Role", "role_name": r, "desk_access": 0}).insert(ignore_permissions=True)
first, _, last = full_name.partition(" ")
if frappe.db.exists("User", email):
    user = frappe.get_doc("User", email)
    for r in set(roles) - {x.role for x in user.roles}:
        user.append("roles", {"role": r})
    user.save(ignore_permissions=True)
else:
    user = frappe.get_doc({"doctype": "User", "email": email, "first_name": first or email,
                           "last_name": last or None, "user_type": "System User",
                           "send_welcome_email": 0,
                           "roles": [{"role": r} for r in roles]}).insert(ignore_permissions=True)
link = user._reset_password(send_email=False)
frappe.db.commit()
print("OWNER " + user.name)
print("ACTIVATE" + link)
"""


def hotel_base_url(site: str) -> str:
    """How the hotel's site is reached: https://<site> on a server; the
    `lodgiva_hotel_url` template (e.g. http://{site}:8002) on a laptop."""
    return (frappe.conf.get("lodgiva_hotel_url") or "https://{site}").format(site=site)


def create_owner(doc, hide: list[str] | None = None) -> str:
    """Create (or refresh) the owner's account on their site; return a fresh
    one-time activation link. A new link voids the previous one."""
    bench_path = frappe.utils.get_bench_path()
    out = _run(
        doc,
        [os.path.join(bench_path, "env", "bin", "python"), "-c", OWNER_SCRIPT, doc.site_name,
         doc.owner_email, doc.customer_name or doc.owner_email, ",".join(OWNER_ROLES)],
        hide or [],
        cwd=os.path.join(bench_path, "sites"),
    )
    link = next((ln[8:] for ln in out.splitlines() if ln.startswith("ACTIVATE")), None)
    if not link:
        raise RuntimeError("owner account was not created")
    return link


def activate_owner(doc, hide: list[str] | None = None) -> bool:
    """Owner account plus activation email. False when mail is not set up,
    which must not fail a finished site: the operator resends later."""
    link = create_owner(doc, hide)
    try:
        send_activation(doc, link)
    except frappe.OutgoingEmailError:
        frappe.clear_last_message()
        _log(doc, "Activation email NOT sent: the control site has no outgoing email "
                  "account. Set one up, then use Resend activation.")
        return False
    _log(doc, f"Activation link emailed to {doc.owner_email}.")
    return True


@frappe.whitelist(methods=["POST"])
def resend_activation(docname: str) -> dict:
    """Operator action: a new activation link for the owner of an Active site."""
    frappe.only_for(["Lodgiva Operator", "System Manager"])
    doc = frappe.get_doc("Hotel Environment", docname)
    if doc.status != "Active" or not site_exists(doc.site_name):
        frappe.throw("Only an Active environment with a site on disk has an owner to activate.")
    sent = activate_owner(doc)
    doc.add_comment("Info", f"Activation {'resent' if sent else 'regenerated, email not sent'} "
                            f"by {frappe.session.user}.")
    return {"sent": sent, "owner": doc.owner_email}


def send_activation(doc, link: str) -> None:
    """Email the owner their one-time activation link, from the control site."""
    frappe.sendmail(
        recipients=[doc.owner_email],
        subject=f"Activate your Lodgiva account for {doc.property_name or doc.customer_name}",
        message=(
            f"<p>Your hotel system is ready at <a href='{hotel_base_url(doc.site_name)}'>"
            f"{hotel_base_url(doc.site_name)}</a>.</p>"
            f"<p><a href='{link}'>Set your password</a> to sign in as {doc.owner_email}. "
            "The link works once and expires in two days.</p>"
        ),
        reference_doctype=doc.doctype,
        reference_name=doc.name,
    )


def setup_property_payload(doc) -> str:
    """Build the argument for kamra.api.setup_property from the form."""
    return json.dumps({"payload": _property_payload(doc)})


def _property_payload(doc) -> dict:
    """The hotel, as kamra.api.setup_property expects it."""
    return {
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


def provision(docname: str) -> None:
    """Create the customer's site. Enqueued; never called in a request path."""
    doc = frappe.get_doc("Hotel Environment", docname)
    site = doc.site_name

    try:
        # Refusing here is what makes a retry safe: a live customer's site can
        # never be half-overwritten by resubmitting a failed record.
        if site_exists(site):
            raise RuntimeError(f"sites/{site} already exists; clean it up before retrying")

        db = db_settings()
        bench = bench_bin()
        admin_password = secrets.token_urlsafe(18)
        hide = [db["password"], admin_password]

        doc.db_set("status", "Provisioning")
        frappe.db.commit()

        _run(doc, [
            bench, "new-site", site,
            "--db-host", db["host"],
            "--db-port", db["port"],
            "--db-root-username", db["user"],
            "--db-root-password", db["password"],
            # MariaDB resolves 127.0.0.1 back to the name "localhost", so a user
            # granted only on 127.0.0.1 is refused at login. '%' covers both.
            "--mariadb-user-host-login-scope=%",
            "--no-mariadb-socket",
            "--admin-password", admin_password,
            "--install-app", "payments",
            "--install-app", "kamra",
            "--install-app", "lodgiva_nigeria",
        ], hide)

        _run(doc, [bench, "--site", site, "set-config", "host_name", hotel_base_url(site)], hide)
        _run(doc, [bench, "--site", site, "enable-scheduler"], hide)
        # Seed the hotel by calling the function directly rather than through
        # `bench execute`: that command eval()s the dotted path without
        # importing it, so it dies with "name 'kamra' is not defined". Running
        # the bench's own python from sites/ is what `bench console` does, and
        # it imports normally.
        bench_path = frappe.utils.get_bench_path()
        seed = (
            "import json, frappe, kamra.api\n"
            f"frappe.init(site={site!r})\n"
            "frappe.connect()\n"
            f"kamra.api.setup_property(payload=json.loads({json.dumps(_property_payload(doc))!r}))\n"
            "frappe.db.commit()\n"
            "print('property seeded')\n"
        )
        _run(
            doc,
            [os.path.join(bench_path, "env", "bin", "python"), "-c", seed],
            hide,
            cwd=os.path.join(bench_path, "sites"),
        )

        # The owner signs in as themselves. Administrator stays a break-glass
        # account for Lodgiva support; its password is never handed out.
        activate_owner(doc, hide)

        # db_set writes the column verbatim, which for a Password field means
        # plaintext in tabHotel Environment. Store it encrypted in __Auth the
        # way a normal save would, and leave only the mask in the column.
        from frappe.utils.password import set_encrypted_password

        set_encrypted_password(doc.doctype, doc.name, admin_password, "admin_password")
        doc.db_set("admin_password", "*" * len(admin_password))
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
