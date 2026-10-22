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

        self.validate_rooms()

    def validate_rooms(self):
        """Catch a room setup the seeder would reject.

        Without this the mismatch surfaces only after `bench new-site` has
        already built the customer's site, several minutes in, leaving a
        half-provisioned environment to clean up by hand.
        """
        codes = [(row.code or "").strip() for row in self.room_types]
        codes = [c for c in codes if c]

        if not codes:
            frappe.throw(
                "Add at least one room type before provisioning - the hotel "
                "needs something to sell."
            )

        duplicates = {c for c in codes if codes.count(c) > 1}
        if duplicates:
            frappe.throw(f"Duplicate room type code: {', '.join(sorted(duplicates))}")

        for row in self.room_blocks:
            code = (row.room_type_code or "").strip()
            if code not in codes:
                frappe.throw(
                    f"Room Numbers row {row.idx}: '{code}' is not one of this "
                    f"hotel's room type codes ({', '.join(codes)}). "
                    "Put the room type's code here, and the room numbers in "
                    "the next column."
                )
            if not (row.numbers or "").strip():
                frappe.throw(f"Room Numbers row {row.idx}: list at least one room number.")

    def on_submit(self):
        self.enqueue_provision()

    def enqueue_provision(self):
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


@frappe.whitelist()
def retry(docname: str):
    """Re-run provisioning for a record that failed.

    Submitting once sets docstatus to 1, so a failed record cannot simply be
    submitted again - without this an operator would have to delete it and
    retype everything. The site-exists check below is what keeps a retry safe:
    a live customer's site is never touched.
    """
    doc = frappe.get_doc("Hotel Environment", docname)
    doc.check_permission("submit")

    if doc.status == "Provisioning":
        frappe.throw("This environment is already being provisioned.")
    if doc.status == "Active":
        frappe.throw("This environment is already active.")

    if site_exists(doc.site_name):
        frappe.throw(
            f"sites/{doc.site_name} still exists on disk from the failed run. "
            "Remove it on the server first, then retry."
        )

    doc.db_set("provision_log", "")
    frappe.db.commit()
    doc.enqueue_provision()
    return "queued"
