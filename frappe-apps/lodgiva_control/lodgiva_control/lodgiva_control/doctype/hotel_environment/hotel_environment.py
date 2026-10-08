import frappe
from frappe.model.document import Document

from lodgiva_control.provisioning import (
    PROVISION_TIMEOUT,
    site_exists,
    site_name,
    validate_subdomain,
)


class HotelEnvironment(Document):
    def validate(self):
        self.subdomain = (self.subdomain or "").strip().lower()
        validate_subdomain(self.subdomain)

        # Derived, never typed: the site directory name and the hostname are
        # the same string, and letting them drift would mean a site nobody can
        # reach.
        self.site_name = site_name(self.subdomain)

        if self.is_new() and site_exists(self.site_name):
            frappe.throw(f"A site already exists at {self.site_name}.")

    def on_submit(self):
        frappe.enqueue(
            "lodgiva_control.provisioning.provision",
            queue="long",
            timeout=PROVISION_TIMEOUT,
            docname=self.name,
        )
        frappe.msgprint(
            f"Provisioning {self.site_name}. This takes a few minutes; "
            "the status and log on this page update as it runs."
        )
