// Form behaviour for Hotel Environment.
//
// Everything here is read-only convenience: opening the finished site, copying
// the password once, and telling the operator what a failed provision needs.
// Nothing on this form provisions anything — that is the submit handler and its
// background job.

frappe.ui.form.on("Hotel Environment", {
  refresh(frm) {
    frm.trigger("lodgiva_banner");
    frm.trigger("lodgiva_buttons");

    // A provision takes minutes, so the page would otherwise sit on a stale
    // status until someone reloaded it.
    if (frm.doc.status === "Provisioning") {
      frm.dashboard.add_comment(
        __("Provisioning is running in the background. This page refreshes itself."),
        "blue",
        true
      );
      if (!frm.__lodgiva_poll) {
        frm.__lodgiva_poll = setInterval(() => {
          frappe.db.get_value("Hotel Environment", frm.doc.name, "status").then((r) => {
            const status = r && r.message && r.message.status;
            if (status && status !== "Provisioning") {
              clearInterval(frm.__lodgiva_poll);
              frm.__lodgiva_poll = null;
              frm.reload_doc();
            }
          });
        }, 5000);
      }
    } else if (frm.__lodgiva_poll) {
      clearInterval(frm.__lodgiva_poll);
      frm.__lodgiva_poll = null;
    }
  },

  lodgiva_banner(frm) {
    if (frm.doc.status === "Failed") {
      frm.dashboard.set_headline(
        __(
          "Provisioning failed. The half-created site is left on disk on purpose — read the log below, remove it by hand, then submit again."
        )
      );
    } else if (frm.doc.status === "Active" && frm.doc.site_name) {
      frm.dashboard.set_headline(
        __("Live at {0}", [`<a href="https://${frm.doc.site_name}" target="_blank">${frm.doc.site_name}</a>`])
      );
    }
  },

  lodgiva_buttons(frm) {
    frm.page.clear_secondary_action();

    if (frm.doc.status === "Active" && frm.doc.site_name) {
      frm.add_custom_button(__("Open site"), () => {
        window.open(`https://${frm.doc.site_name}`, "_blank");
      });

      frm.add_custom_button(__("Copy sign-in details"), () => {
        // The generated password is shown once here so the operator can hand it
        // over; the customer is expected to change it on first sign-in.
        frappe.call({
          method: "frappe.client.get_password",
          args: { doctype: "Hotel Environment", name: frm.doc.name, fieldname: "admin_password" },
          callback(r) {
            const password = (r && r.message) || "";
            if (!password) {
              frappe.msgprint(__("No password stored on this record."));
              return;
            }
            frappe.utils.copy_to_clipboard(
              `Site: https://${frm.doc.site_name}\nUser: Administrator\nPassword: ${password}`
            );
            frappe.show_alert({ message: __("Sign-in details copied"), indicator: "green" });
          },
        });
      });
    }

    if (frm.doc.status === "Draft" && !frm.is_new()) {
      frm.page.set_secondary_action(__("Submit to provision"), () => frm.savesubmit());
    }
  },

  subdomain(frm) {
    // Mirror the server's rule in the UI so the operator sees the problem while
    // typing instead of on submit. The server still validates; this is only a
    // courtesy, never the gate.
    const value = (frm.doc.subdomain || "").trim().toLowerCase();
    if (value !== frm.doc.subdomain) {
      frm.set_value("subdomain", value);
      return;
    }
    if (!value) return;

    const reserved = ["www", "api", "admin", "control", "app", "assets", "files"];
    const shape = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

    if (!shape.test(value)) {
      frm.dashboard.clear_headline();
      frm.set_df_property(
        "subdomain",
        "description",
        __("3-32 lowercase letters, digits or hyphens, not starting or ending with a hyphen.")
      );
    } else if (reserved.includes(value)) {
      frm.set_df_property("subdomain", "description", __("'{0}' is reserved.", [value]));
    } else {
      frm.set_df_property("subdomain", "description", __("Becomes the hostname and cannot be changed later."));
    }
  },
});
