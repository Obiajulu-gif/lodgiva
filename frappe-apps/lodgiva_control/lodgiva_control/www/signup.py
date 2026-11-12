import frappe

no_cache = 1


def get_context(context):
    context.apex = frappe.conf.get("lodgiva_apex") or ""
