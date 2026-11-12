// Colour the list so an operator can see the state of every customer
// environment without opening a single record.
frappe.listview_settings["Hotel Environment"] = {
  add_fields: ["status", "site_name"],

  get_indicator(doc) {
    const states = {
      Draft: ["Draft", "gray", "status,=,Draft"],
      // Orange rather than blue: a provision that is still running is the one
      // state an operator may need to act on if it stalls.
      Provisioning: ["Provisioning", "orange", "status,=,Provisioning"],
      Active: ["Active", "green", "status,=,Active"],
      Failed: ["Failed", "red", "status,=,Failed"],
    };
    return states[doc.status] || states.Draft;
  },

  formatters: {
    site_name(value) {
      return value ? `<span class="text-muted">${frappe.utils.escape_html(value)}</span>` : "";
    },
  },
};
