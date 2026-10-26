import frappe
from frappe.model.document import Document
from frappe.utils import add_days, nowdate

TRIAL_DAYS = 15


class HotelSubscription(Document):
    def before_insert(self):
        # Every subscription starts its trial at creation. A record created by
        # the backfill patch overrides state explicitly; it must not inherit a
        # fresh trial, or every existing customer gets 15 free days by
        # accident.
        if not self.trial_ends_on:
            self.trial_ends_on = add_days(nowdate(), TRIAL_DAYS)
        if not self.state:
            self.state = "trialing"
        if not self.access_mode:
            self.access_mode = "full"

    def log(self, message: str) -> None:
        """Append one dated line to the immutable history of this record."""
        stamp = frappe.utils.now()
        self.db_set(
            "state_log",
            f"{self.state_log or ''}{stamp}  {message}\n",
            update_modified=False,
        )
