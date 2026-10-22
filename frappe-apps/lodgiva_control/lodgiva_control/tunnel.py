"""A public URL per hotel, for demo and development benches.

Every hotel is its own Frappe site, resolved by Host header. On a server each
one is simply a subdomain of the apex and needs nothing here. On a laptop there
is no public DNS and a Cloudflare quick tunnel serves exactly one hostname with
no wildcard, so each site gets its own tunnel instead.

cloudflared rewrites the Host header on the way through (`--http-host-header`),
which is what makes one shared Frappe on 8002 answer as the right site.

This is a development convenience. In production the apex plus wildcard DNS
does the same job without a process per customer.
"""

import os
import re
import signal
import subprocess
import time

import frappe

URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
START_TIMEOUT = 60


def _cloudflared_bin() -> str:
    configured = frappe.conf.get("lodgiva_cloudflared_bin")
    if configured and os.path.exists(configured):
        return configured
    for candidate in ("/home/frappe/cloudflared", "/usr/local/bin/cloudflared"):
        if os.path.exists(candidate):
            return candidate
    frappe.throw(
        "cloudflared was not found. Set lodgiva_cloudflared_bin in the control "
        "site's config to its absolute path."
    )


def _upstream() -> str:
    """Where Frappe itself answers. Not the router: the tunnel sets its own
    Host header, and the router would overwrite it."""
    return frappe.conf.get("lodgiva_frappe_upstream") or "http://localhost:8002"


def _log_path(site: str) -> str:
    return os.path.join(frappe.utils.get_bench_path(), "logs", f"tunnel-{site}.log")


def running_pid(site: str) -> int | None:
    """PID of this site's tunnel, or None. Checked against the process table so
    a stale pid file never reports a tunnel that is gone."""
    pid_file = os.path.join(frappe.utils.get_bench_path(), "logs", f"tunnel-{site}.pid")
    if not os.path.exists(pid_file):
        return None
    try:
        pid = int(open(pid_file).read().strip())
        os.kill(pid, 0)
        return pid
    except (ValueError, ProcessLookupError, PermissionError, OSError):
        return None


def _write_pid(site: str, pid: int) -> None:
    logs = os.path.join(frappe.utils.get_bench_path(), "logs")
    os.makedirs(logs, exist_ok=True)
    with open(os.path.join(logs, f"tunnel-{site}.pid"), "w") as handle:
        handle.write(str(pid))


def start(site: str) -> str:
    """Start a quick tunnel for `site` and return its public URL."""
    log_file = _log_path(site)
    os.makedirs(os.path.dirname(log_file), exist_ok=True)
    # Truncate: the URL is scraped from this file, and a previous run's URL
    # would otherwise be picked up and reported as live.
    open(log_file, "w").close()

    with open(log_file, "ab") as sink:
        proc = subprocess.Popen(
            [
                _cloudflared_bin(), "tunnel", "--no-autoupdate",
                "--url", _upstream(),
                # Makes the shared Frappe answer as this site rather than the
                # bench's default_site.
                "--http-host-header", site,
            ],
            stdout=sink,
            stderr=sink,
            stdin=subprocess.DEVNULL,
            # Detach so the tunnel outlives the worker job that started it.
            start_new_session=True,
        )

    _write_pid(site, proc.pid)

    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"cloudflared exited early; see {log_file}")
        found = URL_PATTERN.search(open(log_file, errors="replace").read())
        if found:
            return found.group(0)
        time.sleep(2)

    raise RuntimeError(f"no tunnel URL after {START_TIMEOUT}s; see {log_file}")


def stop(site: str) -> bool:
    pid = running_pid(site)
    if not pid:
        return False
    os.kill(pid, signal.SIGTERM)
    return True


@frappe.whitelist()
def start_for_environment(docname: str) -> str:
    """Give one hotel environment its own public URL."""
    doc = frappe.get_doc("Hotel Environment", docname)
    doc.check_permission("write")

    if doc.status != "Active":
        frappe.throw("Only an Active environment can be published.")

    if running_pid(doc.site_name):
        stop(doc.site_name)
        time.sleep(2)

    url = start(doc.site_name)
    doc.db_set("public_url", url)
    frappe.db.commit()
    return url


@frappe.whitelist()
def stop_for_environment(docname: str) -> str:
    doc = frappe.get_doc("Hotel Environment", docname)
    doc.check_permission("write")
    stopped = stop(doc.site_name)
    doc.db_set("public_url", "")
    frappe.db.commit()
    return "stopped" if stopped else "was not running"
