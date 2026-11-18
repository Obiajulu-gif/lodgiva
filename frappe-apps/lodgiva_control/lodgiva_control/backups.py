"""Backup and restore evidence per hotel site.

The off-site script (scripts/lodgiva-offsite-backup.sh) and the restore
rehearsal (scripts/lodgiva-restore-rehearsal.sh) call `record` through
`bench --site <control> execute`, so no HTTP credential is involved.
"""

import frappe
from frappe.utils import get_datetime, now_datetime

KINDS = ("Backup", "Off-site copy", "Restore verified")
# A nightly job that missed one night is late; missing two is an incident.
STALE_HOURS = 26


def record(site: str, kind: str, location: str = "", size_mb: float = 0, note: str = "",
           data_as_of: str | None = None, duration_s: int | None = None, at: str | None = None) -> str:
    if kind not in KINDS:
        frappe.throw(f"kind must be one of {KINDS}")
    doc = frappe.get_doc({
        "doctype": "Backup Event", "site_name": site, "kind": kind, "at": at or now_datetime(),
        "location": location, "size_mb": size_mb, "note": note, "data_as_of": data_as_of,
        "duration_s": duration_s, "recorded_by": frappe.session.user,
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    return doc.name


def latest(site: str) -> dict:
    """Newest event of each kind for one site: {kind: {at, location, ...}}."""
    out = {}
    for kind in KINDS:
        row = frappe.get_all("Backup Event", filters={"site_name": site, "kind": kind},
                             fields=["at", "location", "size_mb", "data_as_of", "duration_s"],
                             order_by="at desc", limit=1)
        out[kind] = row[0] if row else None
    return out


def hours_since(ev) -> float | None:
    if not ev:
        return None
    return (now_datetime() - get_datetime(ev["at"])).total_seconds() / 3600


# What a restore must bring back. Run on a site with the bench's python.
FACTS_SCRIPT = """
import frappe, json, os, sys
frappe.init(site=sys.argv[1]); frappe.connect()
db = frappe.db
files = db.sql("select file_url, is_private from tabFile where is_folder=0 and file_url like '/%%files/%%'", as_dict=True)
missing = [f.file_url for f in files if not os.path.exists(frappe.get_site_path(
    ("private" if f.is_private else "public"), "files", f.file_url.rsplit("/", 1)[-1]))]
out = {"reservations": db.count("Reservation"), "folios": db.count("Folio"),
       "folio_payments": db.count("Folio Payment"), "files": len(files), "missing_files": missing[:20],
       "data_as_of": str(max(filter(None, [db.sql("select max(modified) from tabReservation")[0][0],
                                           db.sql("select max(modified) from tabFolio")[0][0]]), default="") or "")}
print("FACTS" + json.dumps(out))
"""


def _bench_python(args: list[str], stdin: str = "") -> str:
    import os
    import subprocess

    bench = frappe.utils.get_bench_path()
    r = subprocess.run([os.path.join(bench, "env", "bin", "python"), *args], cwd=os.path.join(bench, "sites"),
                       capture_output=True, text=True, timeout=600, input=stdin)
    return r.stdout + r.stderr


def facts(site: str) -> dict:
    import json

    out = _bench_python(["-c", FACTS_SCRIPT, site])
    line = next((ln for ln in out.splitlines() if ln.startswith("FACTS")), None)
    if not line:
        frappe.throw(f"Could not read {site}: {out.strip()[-300:]}")
    return json.loads(line[5:])


def _run(args: list[str], hide: list[str]) -> str:
    import subprocess

    from lodgiva_control.provisioning import _redact

    r = subprocess.run(args, cwd=frappe.utils.get_bench_path(), capture_output=True, text=True, timeout=3600)
    out = _redact((r.stdout or "") + (r.stderr or ""), hide)
    if r.returncode:
        frappe.throw(f"{_redact(' '.join(args[:3]), hide)} failed: {out.strip()[-400:]}")
    return out


def offsite(site: str, target: str) -> dict:
    """Back a site up (with files) and copy the set off the server.

    target: an rclone remote ("r2:lodgiva-backups") when rclone is installed,
    else a directory on another disk or mount. The copy is checksummed, and
    the counts at backup time travel with it so a restore can be verified.
    """
    import glob
    import hashlib
    import json
    import os
    import shutil
    import subprocess

    from lodgiva_control.provisioning import bench_bin

    before = facts(site)
    _run([bench_bin(), "--site", site, "backup", "--with-files"], [])
    bdir = os.path.join(frappe.utils.get_bench_path(), "sites", site, "private", "backups")
    newest_db = max(glob.glob(os.path.join(bdir, "*-database.sql.gz")), key=os.path.getmtime)
    stamp = os.path.basename(newest_db).split("-")[0]
    paths = sorted(p for p in glob.glob(os.path.join(bdir, stamp + "-*")) if not p.endswith("-manifest.json"))
    dest = f"{target.rstrip('/')}/{site}/{stamp}"
    sha = {os.path.basename(p): hashlib.sha256(open(p, "rb").read()).hexdigest() for p in paths}
    manifest = os.path.join(os.path.dirname(paths[0]), f"{stamp}-manifest.json")
    json.dump({"site": site, "facts": before, "sha256": sha}, open(manifest, "w"), indent=1)
    if ":" in target.split("/")[0] and shutil.which("rclone"):
        subprocess.run(["rclone", "copy", "--checksum", *[f for f in paths + [manifest]], dest], check=True)
        location = dest
    else:
        os.makedirs(dest, exist_ok=True)
        for p in paths + [manifest]:
            shutil.copy2(p, dest)
        bad = [n for n, h in sha.items() if hashlib.sha256(open(os.path.join(dest, n), "rb").read()).hexdigest() != h]
        if bad:
            frappe.throw(f"Off-site copy corrupt: {bad}")
        location = dest
    size = sum(os.path.getsize(p) for p in paths) / 1e6
    name = record(site, "Off-site copy", location=location, size_mb=round(size, 2),
                  note=json.dumps(before), data_as_of=before.get("data_as_of") or None)
    return {"event": name, "location": location, "files": list(sha), "facts": before}


def rehearse(site: str, source_dir: str, target_site: str) -> dict:
    """Restore the newest off-site copy of `site` into a disposable
    `target_site`, then verify reservations, folios and attachments against
    the counts captured at backup time. Records the time it took and how
    recent the restored data is. Never touches `site` itself."""
    import glob
    import json
    import os
    import time

    from lodgiva_control.provisioning import bench_bin, db_settings, site_exists

    if target_site == site or not target_site.startswith(("rehearsal", "restore")):
        frappe.throw("Restore only into a disposable site named rehearsal*/restore*.")
    sets = sorted(glob.glob(os.path.join(source_dir, site, "*", "*-manifest.json")))
    if not sets:
        frappe.throw(f"No off-site backup of {site} in {source_dir}.")
    manifest = json.load(open(sets[-1]))
    folder = os.path.dirname(sets[-1])
    pick = lambda suffix: next((os.path.join(folder, n) for n in manifest["sha256"] if n.endswith(suffix)), None)  # noqa: E731
    db_file, pub, priv = pick("database.sql.gz"), pick("files.tar"), pick("private-files.tar")
    db = db_settings()
    hide = [db["password"]]
    started = time.monotonic()
    bench = bench_bin()
    if site_exists(target_site):
        _run([bench, "drop-site", target_site, "--db-root-username", db["user"], "--db-root-password",
              db["password"], "--force", "--no-backup"], hide)
    _run([bench, "new-site", target_site, "--db-host", db["host"], "--db-port", db["port"],
          "--db-root-username", db["user"], "--db-root-password", db["password"],
          "--mariadb-user-host-login-scope=%", "--no-mariadb-socket",
          "--admin-password", frappe.generate_hash(length=20)], hide)
    restore = [bench, "--site", target_site, "restore", db_file, "--db-root-username", db["user"],
               "--db-root-password", db["password"], "--force"]
    if pub:
        restore += ["--with-public-files", pub]
    if priv:
        restore += ["--with-private-files", priv]
    _run(restore, hide)
    _run([bench, "--site", target_site, "migrate"], hide)
    got = facts(target_site)
    duration = int(time.monotonic() - started)
    want = manifest["facts"]
    checks = {k: (want.get(k), got.get(k)) for k in ("reservations", "folios", "folio_payments", "files")}
    ok = all(a == b for a, b in checks.values()) and not got["missing_files"]
    if ok:
        record(site, "Restore verified", location=f"{target_site} from {folder}", duration_s=duration,
               data_as_of=got.get("data_as_of") or None, note=json.dumps(checks))
    return {"ok": ok, "checks": checks, "missing_files": got["missing_files"], "duration_s": duration,
            "data_as_of": got.get("data_as_of"), "backup_folder": folder}
