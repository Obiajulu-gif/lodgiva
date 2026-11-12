"""Support access to a customer's site: one site, a reason, an expiry.

Operators never share a hotel's Administrator password. `grant` creates a
dedicated user on that one site (Hotel Admin, Front Desk, Finance - not
System Manager), sets a random password shown once to the operator who
asked, and records who, why and until when. `expire_grants` (hourly) and
`revoke` disable that user on the site. Every grant is a record with its
own change history, so cross-customer access is always auditable.
"""

import os
import secrets
import subprocess

import frappe
from frappe.utils import add_to_date, get_datetime, now_datetime

from lodgiva_control.provisioning import site_exists

MAX_HOURS = 24
ROLES = ("Hotel Admin", "Front Desk", "Finance")

SITE_SCRIPT = """
import frappe, sys
site, email, action, roles = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(",")
frappe.init(site=site)
frappe.connect()
if action == "enable":
    pw = sys.stdin.readline().strip()
    if frappe.db.exists("User", email):
        u = frappe.get_doc("User", email)
        u.enabled = 1
        for r in set(roles) - {x.role for x in u.roles}:
            u.append("roles", {"role": r})
        u.save(ignore_permissions=True)
    else:
        frappe.get_doc({"doctype": "User", "email": email, "first_name": "Lodgiva Support",
                        "user_type": "System User", "send_welcome_email": 0,
                        "roles": [{"role": r} for r in roles]}).insert(ignore_permissions=True)
    from frappe.utils.password import update_password
    update_password(email, pw)
else:
    if frappe.db.exists("User", email):
        frappe.db.set_value("User", email, "enabled", 0)
        from frappe.sessions import clear_sessions
        clear_sessions(user=email, force=True)
frappe.db.commit()
print("DONE " + action)
"""


def _on_site(site: str, email: str, action: str, password: str = "") -> None:
    bench = frappe.utils.get_bench_path()
    r = subprocess.run(
        [os.path.join(bench, "env", "bin", "python"), "-c", SITE_SCRIPT, site, email, action, ",".join(ROLES)],
        input=password + "\n", cwd=os.path.join(bench, "sites"), capture_output=True, text=True, timeout=120,
    )
    if f"DONE {action}" not in r.stdout:
        frappe.throw(f"Could not {action} support user on {site}: {(r.stderr or r.stdout).strip()[-300:]}")


def support_email(grant_name: str) -> str:
    return f"support-{grant_name.lower()}@support.lodgiva.com"


@frappe.whitelist(methods=["POST"])
def grant(hotel_environment: str, reason: str, hours: float = 2) -> dict:
    frappe.only_for(["Lodgiva Operator", "System Manager"])
    reason = (reason or "").strip()
    if len(reason) < 10:
        frappe.throw("Say why you need access (at least 10 characters). It goes on the record.")
    hours = float(hours)
    if not 0 < hours <= MAX_HOURS:
        frappe.throw(f"Access lasts between a few minutes and {MAX_HOURS} hours.")
    env = frappe.get_doc("Hotel Environment", hotel_environment)
    if env.status != "Active" or not site_exists(env.site_name):
        frappe.throw("Only an Active hotel site can be opened for support.")
    doc = frappe.get_doc({
        "doctype": "Support Access Grant", "hotel_environment": env.name, "site_name": env.site_name,
        "granted_to": frappe.session.user, "reason": reason,
        "expires_at": add_to_date(now_datetime(), hours=hours), "status": "Active",
    }).insert(ignore_permissions=True)
    doc.db_set("support_user", support_email(doc.name))
    password = secrets.token_urlsafe(14)
    _on_site(env.site_name, doc.support_user, "enable", password)
    env.add_comment("Info", f"Support access {doc.name} granted to {frappe.session.user} until "
                            f"{doc.expires_at}: {reason}")
    frappe.db.commit()
    from lodgiva_control.console import hotel_url
    # The password is returned to this operator once and stored nowhere.
    return {"grant": doc.name, "login": hotel_url(env.site_name, env.public_url) + "/login",
            "user": doc.support_user, "password": password, "expires_at": str(doc.expires_at)}


def _close(doc, status: str) -> None:
    _on_site(doc.site_name, doc.support_user, "disable")
    doc.db_set({"status": status, "revoked_by": frappe.session.user if status == "Revoked" else None,
                "revoked_at": now_datetime()})


@frappe.whitelist(methods=["POST"])
def revoke(grant_name: str) -> str:
    frappe.only_for(["Lodgiva Operator", "System Manager"])
    doc = frappe.get_doc("Support Access Grant", grant_name)
    if doc.status != "Active":
        return doc.status
    _close(doc, "Revoked")
    frappe.get_doc("Hotel Environment", doc.hotel_environment).add_comment(
        "Info", f"Support access {doc.name} revoked by {frappe.session.user}.")
    return "Revoked"


def expire_grants() -> int:
    """Hourly: disable every support user whose grant has run out."""
    n = 0
    for name in frappe.get_all("Support Access Grant", filters={
            "status": "Active", "expires_at": ["<=", now_datetime()]}, pluck="name"):
        doc = frappe.get_doc("Support Access Grant", name)
        try:
            _close(doc, "Expired")
            n += 1
        except Exception:
            frappe.log_error(title=f"Support access {name} did not expire cleanly")
    frappe.db.commit()
    return n


def active_grants(env_name: str) -> list[dict]:
    return [g for g in frappe.get_all(
        "Support Access Grant", filters={"hotel_environment": env_name, "status": "Active"},
        fields=["name", "granted_to", "expires_at", "reason"]) if get_datetime(g.expires_at) > now_datetime()]
