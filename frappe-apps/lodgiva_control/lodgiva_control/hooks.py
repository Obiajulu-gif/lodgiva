app_name = "lodgiva_control"
app_title = "Lodgiva Control"
app_publisher = "Lodgiva"
app_description = "Provisions a Lodgiva PMS environment (one Frappe site) per hotel customer."
app_email = "hello@lodgiva.com"
app_license = "agpl-3.0"

# The certificate gate Caddy calls before issuing. It must answer for hosts
# that have no session and no cookies, so it is guest-allowed in api.py and
# bound to localhost there — not exposed through any authenticated route.
