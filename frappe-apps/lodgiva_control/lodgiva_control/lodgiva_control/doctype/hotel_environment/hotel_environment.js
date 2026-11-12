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
    frm.trigger("lodgiva_sync_room_codes");

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
    } else if (frm.doc.status === "Active" && frm.doc.public_url) {
      frm.dashboard.set_headline(
        __("Live at {0}", [`<a href="${frm.doc.public_url}" target="_blank">${frm.doc.public_url}</a>`])
      );
    } else if (frm.doc.status === "Active" && frm.doc.site_name) {
      frm.dashboard.set_headline(
        __(
          "Provisioned as {0}. On this bench that name only resolves locally - use Publish public link to reach it from outside.",
          [frm.doc.site_name]
        )
      );
    }
  },

  lodgiva_buttons(frm) {
    frm.page.clear_secondary_action();

    if (frm.doc.status === "Active" && frm.doc.site_name) {
      // Prefer the tunnel when one is published: on a laptop the site name is
      // only resolvable on this machine.
      frm.add_custom_button(__("Open site"), () => {
        window.open(frm.doc.public_url || `https://${frm.doc.site_name}`, "_blank");
      });

      frm.add_custom_button(
        frm.doc.public_url ? __("Restart public link") : __("Publish public link"),
        () => {
          frappe.call({
            method: "lodgiva_control.tunnel.start_for_environment",
            args: { docname: frm.doc.name },
            freeze: true,
            freeze_message: __("Starting tunnel; this takes up to a minute..."),
            callback(r) {
              if (r.message) {
                frappe.show_alert({ message: __("Published at {0}", [r.message]), indicator: "green" });
                frm.reload_doc();
              }
            },
          });
        }
      );

      if (frm.doc.public_url) {
        frm.add_custom_button(__("Stop public link"), () => {
          frappe.call({
            method: "lodgiva_control.tunnel.stop_for_environment",
            args: { docname: frm.doc.name },
            freeze: true,
            callback() {
              frappe.show_alert({ message: __("Public link stopped"), indicator: "orange" });
              frm.reload_doc();
            },
          });
        });
      }

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

    if (frm.doc.status === "Draft" && !frm.is_new() && frm.doc.docstatus === 0) {
      frm.page.set_secondary_action(__("Submit to provision"), () => frm.savesubmit());
    }

    // A failed record is already submitted, so it cannot be submitted again.
    // Without this the operator would have to delete it and retype everything.
    if (frm.doc.status === "Failed") {
      frm.add_custom_button(__("Retry provisioning"), () => {
        frappe.call({
          method: "lodgiva_control.lodgiva_control.doctype.hotel_environment.hotel_environment.retry",
          args: { docname: frm.doc.name },
          freeze: true,
          freeze_message: __("Queueing..."),
          callback() {
            frappe.show_alert({ message: __("Provisioning queued"), indicator: "blue" });
            frm.reload_doc();
          },
        });
      }).addClass("btn-primary");
    }
  },

  room_types_on_form_rendered(frm) {
    frm.trigger("lodgiva_sync_room_codes");
  },

  lodgiva_sync_room_codes(frm) {
    // Offer the codes actually entered above, so a room *number* cannot be
    // typed into the room *type* field. The server validates regardless.
    const codes = (frm.doc.room_types || [])
      .map((r) => (r.code || "").trim())
      .filter(Boolean);
    frm.fields_dict.room_blocks.grid.update_docfield_property(
      "room_type_code",
      "options",
      [""].concat(codes).join("\n")
    );
    frm.fields_dict.room_blocks.grid.refresh();
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
