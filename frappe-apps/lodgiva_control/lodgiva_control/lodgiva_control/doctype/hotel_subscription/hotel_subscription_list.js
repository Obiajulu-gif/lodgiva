// Colour the list so an operator can see every hotel's billing state at a
// glance, and click one state to filter to it.
frappe.listview_settings["Hotel Subscription"] = {
  add_fields: ["state", "access_mode", "plan", "grace_ends_on"],

  get_indicator(doc) {
    const states = {
      trialing: ["Trialing", "blue", "state,=,trialing"],
      active: ["Active", "green", "state,=,active"],
      // Orange, not red: past_due still has full access. It is a warning, not
      // a restriction, and colouring it like one would mislead an operator
      // fielding a phone call.
      past_due: ["Past due", "orange", "state,=,past_due"],
      unpaid: ["Unpaid", "red", "state,=,unpaid"],
      free: ["Free", "gray", "state,=,free"],
      cancelled: ["Cancelled", "darkgrey", "state,=,cancelled"],
      paused: ["Paused", "darkgrey", "state,=,paused"],
    };
    return states[doc.state] || states.free;
  },

  formatters: {
    access_mode(value) {
      if (value !== "read_only") return "";
      return `<span class="indicator-pill red">${__("read-only")}</span>`;
    },
  },
};
