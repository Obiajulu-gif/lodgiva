// Form behaviour for Hotel Subscription.
//
// Everything here answers a question an operator is being asked on the phone:
// why is this hotel restricted, when does their grace run out, and were they
// warned. Nothing here changes state - the daily sweep owns that.

frappe.ui.form.on("Hotel Subscription", {
  refresh(frm) {
    frm.trigger("lodgiva_banner");

    if (frm.doc.state === "past_due" || frm.doc.state === "unpaid") {
      frm.add_custom_button(__("Mark payment received"), () => {
        frappe.confirm(
          __("Record a successful payment for {0}? This returns the hotel to active immediately.",
             [frm.doc.hotel_environment]),
          () => {
            frappe.call({
              method: "lodgiva_control.subscription.mark_payment_succeeded",
              args: { subscription: frm.doc.name },
              freeze: true,
              callback() {
                frappe.show_alert({ message: __("Subscription is active"), indicator: "green" });
                frm.reload_doc();
              },
            });
          }
        );
      }).addClass("btn-primary");
    }
  },

  lodgiva_banner(frm) {
    frm.dashboard.clear_headline();

    if (frm.doc.access_mode === "read_only") {
      frm.dashboard.set_headline(
        __("This hotel is read-only. Staff can still check out guests already in the hotel and take folio payments, but cannot create new bookings or post charges.")
      );
      return;
    }

    if (frm.doc.state === "past_due") {
      // The two facts an operator needs while someone is on the phone.
      const notice = frm.doc.suspend_notice_sent_on
        ? __("Suspension notice sent {0}.", [frappe.datetime.str_to_user(frm.doc.suspend_notice_sent_on)])
        : __("No suspension notice has been sent yet, so the hotel cannot be restricted.");
      frm.dashboard.set_headline(
        __("Payment overdue, full access retained. Grace ends {0}. {1}",
           [frappe.datetime.str_to_user(frm.doc.grace_ends_on) || __("(not set)"), notice])
      );
      return;
    }

    if (frm.doc.state === "trialing" && frm.doc.trial_ends_on) {
      frm.dashboard.set_headline(
        __("Trial ends {0}, after which this hotel falls back to the free tier.",
           [frappe.datetime.str_to_user(frm.doc.trial_ends_on)])
      );
    }
  },
});
