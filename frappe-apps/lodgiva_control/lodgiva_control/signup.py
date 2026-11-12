"""Public self-serve signup, wired to the same provisioning an operator uses.

1. `signup` (guest, POST, rate-limited) validates the form and saves a Draft
   Hotel Environment. Nothing is built yet.
2. The owner gets a verification email. `verify` (the link) submits the
   record, which enqueues `provisioning.provision`, exactly as if an operator
   had pressed Submit.
3. When provisioning finishes, the owner gets a second email with a one-time
   link to set their own password on their hotel's site.

Verifying first means a typo'd or hostile address never costs a site build.
"""

import hashlib
import re

import frappe
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, flt, get_url

from lodgiva_control.provisioning import validate_subdomain

TOKEN_TTL = 48 * 3600
EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _key(token: str) -> str:
    return "lodgiva_signup:" + hashlib.sha256(token.encode()).hexdigest()


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=5, seconds=3600)
def signup(hotel_name: str, owner_name: str, email: str, subdomain: str, city: str,
           state: str = "", rooms: int = 10, base_price: float = 0) -> dict:
    email = (email or "").strip().lower()
    subdomain = (subdomain or "").strip().lower()
    if not EMAIL.match(email):
        frappe.throw("Enter a valid email address.")
    if not (hotel_name or "").strip() or not (city or "").strip():
        frappe.throw("Hotel name and city are required.")
    rooms = cint(rooms)
    if not 1 <= rooms <= 300:
        frappe.throw("Rooms must be between 1 and 300.")
    validate_subdomain(subdomain)
    if frappe.db.exists("Hotel Environment", subdomain):
        frappe.throw(f"{subdomain} is taken. Pick another web address.")

    doc = frappe.get_doc({
        "doctype": "Hotel Environment",
        "customer_name": owner_name.strip() or hotel_name.strip(),
        "subdomain": subdomain,
        "owner_email": email,
        "property_name": hotel_name.strip(),
        "city": city.strip(),
        "state": (state or "").strip(),
        "country": "Nigeria",
        "currency": "NGN",
        "room_types": [{"code": "STD", "room_type_name": "Standard",
                        "base_price": flt(base_price) or 30000, "adults": 2}],
        "room_blocks": [{"room_type_code": "STD",
                         "numbers": ",".join(str(100 + i) for i in range(1, rooms + 1))}],
    })
    doc.insert(ignore_permissions=True)
    doc.add_comment("Info", f"Self-serve signup from {frappe.local.request_ip}; waiting for email verification.")

    # ponytail: token lives in redis, so a cache flush voids pending links;
    # store a hash on the record if that ever matters.
    token = frappe.generate_hash(length=32)
    frappe.cache.set_value(_key(token), doc.name, expires_in_sec=TOKEN_TTL)
    link = get_url(f"/api/method/lodgiva_control.signup.verify?token={token}")
    frappe.sendmail(
        recipients=[email],
        subject=f"Confirm your Lodgiva signup for {doc.property_name}",
        message=(f"<p>Confirm this address to start building {doc.property_name} at "
                 f"{doc.site_name}.</p><p><a href='{link}'>Confirm and create my hotel</a></p>"
                 "<p>If you did not sign up, ignore this email.</p>"),
        reference_doctype=doc.doctype, reference_name=doc.name, now=False,
    )
    frappe.db.commit()
    return {"ok": True, "site": doc.site_name,
            "message": f"Check {email} for a confirmation link."}


# nosemgrep: frappe-semgrep-rules.rules.security.guest-whitelisted-method -- an email link has to be a GET; the token is single-use and only starts provisioning that the owner asked for
@frappe.whitelist(allow_guest=True, methods=["GET"])
def verify(token: str | None = None):
    name = frappe.cache.get_value(_key(token or "")) if token else None
    if not name or not frappe.db.exists("Hotel Environment", name):
        frappe.respond_as_web_page("Link expired", "This confirmation link is no longer valid. "
                                   "Sign up again to get a new one.", http_status_code=404)
        return
    doc = frappe.get_doc("Hotel Environment", name)
    if doc.docstatus == 0:
        doc.flags.ignore_permissions = True
        doc.add_comment("Info", "Owner verified their email; provisioning started.")
        doc.submit()
        frappe.db.commit()
    frappe.cache.delete_value(_key(token))
    frappe.respond_as_web_page(
        "Your hotel is being set up",
        f"<p>We are building <b>{frappe.utils.escape_html(doc.site_name)}</b>. It takes a few minutes.</p>"
        f"<p>You will get an email at {frappe.utils.escape_html(doc.owner_email)} with a link "
        "to set your password.</p>",
        indicator_color="green",
    )
