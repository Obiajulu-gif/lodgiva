import frappe
from frappe.model.document import Document


class SubscriptionPlan(Document):
    def validate(self):
        self.plan_code = (self.plan_code or "").strip().upper()
        self.validate_single_free_plan()

    def validate_single_free_plan(self):
        """Exactly one plan may be the free tier.

        A trial that expires falls back to "the free plan". With two of them
        that sentence has no referent, and the fallback would pick whichever
        row the database returned first.
        """
        if not self.is_free:
            return

        other = frappe.db.get_value(
            "Subscription Plan",
            {"is_free": 1, "name": ("!=", self.name or "")},
            "name",
        )
        if other:
            frappe.throw(
                f"'{other}' is already the free tier. Only one plan may carry it."
            )
