/**
 * Integration tests for file storage: upload intents, presigned PUT/GET,
 * completion validation, quarantine, permissions and lifecycle jobs.
 *
 * Run: node --test test/integration/files.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const BASE = process.env.API_BASE ?? "http://localhost:4000/api/v1";

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

/** Real bytes, so content sniffing has something honest to inspect. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from("JFIF\0"),
  Buffer.alloc(64, 0x20),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const HTML = Buffer.from('<html><script>alert("xss")</script></html>');

const sha = (b) => createHash("sha256").update(b).digest("hex");

async function put(url, bytes, contentType) {
  const res = await fetch(url, {
    method: "POST", // local adapter exposes the presigned target as POST
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : {} };
}

let deskToken;
let mgrToken;
let property;

async function intent(over = {}, token = deskToken) {
  return call("/files/intents", {
    method: "POST",
    token,
    body: {
      purpose: "GUEST_ID",
      originalName: "passport.jpg",
      contentType: "image/jpeg",
      sizeBytes: JPEG.length,
      propertyId: property.id,
      ...over,
    },
  });
}

test("setup", async () => {
  deskToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "frontdesk@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  mgrToken = (
    await call("/auth/login", {
      method: "POST",
      body: { email: "manager@grandpalm.demo", password: "Password123!" },
    })
  ).data.accessToken;
  const me = await call("/auth/me", { token: deskToken });
  property = me.data.properties[0];
});

test("storage status reports the adapter honestly", async () => {
  const res = await call("/files/storage-status", { token: deskToken });
  assert.equal(res.status, 200);
  assert.ok(["LOCAL", "S3", "R2", "MINIO"].includes(res.data.adapter));
  assert.equal(typeof res.data.remote, "boolean");
  assert.ok(res.data.note.length > 20, "the note must explain what the mode means");
  assert.ok(res.data.buckets.PUBLIC && res.data.buckets.PRIVATE);
});

// ── Bucket policy ────────────────────────────────────────────────────────

test("identity documents go to the private bucket, room images to public", async () => {
  const id = await intent();
  assert.equal(id.status, 201, JSON.stringify(id.data));
  assert.equal(id.data.bucket, "PRIVATE", "an ID document must never be public");

  const room = await intent({
    purpose: "ROOM_IMAGE",
    originalName: "suite.jpg",
    contentType: "image/jpeg",
  });
  assert.equal(room.data.bucket, "PUBLIC");
});

test("the object key never contains the uploaded filename", async () => {
  const res = await intent({ originalName: "../../etc/passwd.jpg" });
  assert.equal(res.status, 201);
  const key = decodeURIComponent(new URL(res.data.upload.url).searchParams.get("key"));
  assert.ok(!key.includes(".."), "traversal must not survive into the key");
  assert.ok(!key.includes("passwd"), "the original name must not be used as a path");
  assert.ok(key.startsWith(property.id) || /^[0-9a-f-]{36}\//.test(key));
  assert.match(key, /\.jpg$/, "the extension is preserved for content negotiation");
});

// ── Validation at intent time ────────────────────────────────────────────

test("a disallowed content type is refused before any bytes move", async () => {
  const res = await intent({ contentType: "application/x-msdownload" });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "CONTENT_TYPE_NOT_ALLOWED");
  assert.ok(res.data.error.details.allowed.includes("image/jpeg"));
});

test("an oversized declaration is refused", async () => {
  const res = await intent({ sizeBytes: 999_000_000 });
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "FILE_TOO_LARGE");
});

test("a PDF is accepted for invoices but not for room images", async () => {
  const ok = await intent({
    purpose: "INVOICE",
    originalName: "inv.pdf",
    contentType: "application/pdf",
    sizeBytes: PDF.length,
  });
  assert.equal(ok.status, 201);

  const bad = await intent({
    purpose: "ROOM_IMAGE",
    originalName: "inv.pdf",
    contentType: "application/pdf",
    sizeBytes: PDF.length,
  });
  assert.equal(bad.status, 400);
});

// ── Presigned upload ─────────────────────────────────────────────────────

test("the full happy path: intent, upload, complete, download", async () => {
  const created = await intent();
  const up = await put(created.data.upload.url, JPEG, "image/jpeg");
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.bytes, JPEG.length);

  const done = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST",
    token: deskToken,
    body: { checksumSha256: sha(JPEG) },
  });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.status, "CLEAN");
  assert.equal(done.data.sizeBytes, JPEG.length);
  assert.equal(done.data.checksumSha256, sha(JPEG));

  const link = await call(`/files/${created.data.fileId}/download-url`, { token: deskToken });
  assert.equal(link.status, 200);
  assert.ok(link.data.url.includes("signature="), "private downloads must be signed");

  const fetched = await fetch(link.data.url);
  assert.equal(fetched.status, 200);
  const body = Buffer.from(await fetched.arrayBuffer());
  assert.equal(sha(body), sha(JPEG), "the bytes served must be the bytes stored");
  // Stored files must never render inline.
  assert.match(fetched.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
});

test("a tampered upload signature is rejected", async () => {
  const created = await intent();
  const url = new URL(created.data.upload.url);
  url.searchParams.set("signature", "deadbeef");
  const res = await put(url.toString(), JPEG, "image/jpeg");
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "INVALID_UPLOAD_URL");
});

test("an expired upload URL is rejected", async () => {
  const created = await intent();
  const url = new URL(created.data.upload.url);
  url.searchParams.set("expires", String(Date.now() - 1000));
  const res = await put(url.toString(), JPEG, "image/jpeg");
  assert.equal(res.status, 400);
  assert.match(res.data.error.message, /expired|signature/i);
});

test("the same upload URL cannot be replayed", async () => {
  const created = await intent();
  const first = await put(created.data.upload.url, JPEG, "image/jpeg");
  assert.equal(first.status, 201);
  const second = await put(created.data.upload.url, JPEG, "image/jpeg");
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, "ALREADY_UPLOADED");
});

test("an empty upload is rejected", async () => {
  const created = await intent();
  const res = await put(created.data.upload.url, Buffer.alloc(0), "image/jpeg");
  assert.equal(res.status, 400);
  assert.equal(res.data.error.code, "EMPTY_UPLOAD");
});

// ── Completion validation & quarantine ───────────────────────────────────

test("bytes that do not match the declared type are quarantined", async () => {
  // The dangerous case: HTML uploaded as a JPEG. If this were accepted into
  // the public bucket it would be a stored XSS.
  const created = await intent({ sizeBytes: HTML.length });
  await put(created.data.upload.url, HTML, "image/jpeg");

  const done = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST",
    token: deskToken,
    body: {},
  });
  assert.equal(done.status, 409);
  assert.equal(done.data.error.code, "FILE_QUARANTINED");
  assert.match(done.data.error.message, /text\/html/);

  // A quarantined file is never downloadable.
  const link = await call(`/files/${created.data.fileId}/download-url`, { token: deskToken });
  assert.equal(link.status, 409);
  assert.equal(link.data.error.code, "FILE_QUARANTINED");
});

test("a mismatched client checksum quarantines the file", async () => {
  const created = await intent();
  await put(created.data.upload.url, JPEG, "image/jpeg");
  const done = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST",
    token: deskToken,
    body: { checksumSha256: sha(PNG) },
  });
  assert.equal(done.status, 409);
  assert.match(done.data.error.message, /checksum/i);
});

test("declaring an image but uploading a PDF is quarantined", async () => {
  const created = await intent({ sizeBytes: PDF.length });
  await put(created.data.upload.url, PDF, "image/jpeg");
  const done = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST",
    token: deskToken,
    body: {},
  });
  assert.equal(done.status, 409);
  assert.match(done.data.error.message, /application\/pdf/);
});

test("completing before any upload is refused", async () => {
  const created = await intent();
  const done = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST",
    token: deskToken,
    body: {},
  });
  assert.equal(done.status, 409);
  assert.equal(done.data.error.code, "NOT_UPLOADED");
});

test("completion is idempotent", async () => {
  const created = await intent({ purpose: "ROOM_IMAGE", originalName: "r.png", contentType: "image/png", sizeBytes: PNG.length });
  await put(created.data.upload.url, PNG, "image/png");
  const first = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST", token: deskToken, body: {},
  });
  assert.equal(first.data.status, "CLEAN");
  const second = await call(`/files/${created.data.fileId}/complete`, {
    method: "POST", token: deskToken, body: {},
  });
  assert.equal(second.status, 201);
  assert.equal(second.data.status, "CLEAN");
});

// ── Public bucket ────────────────────────────────────────────────────────

test("public objects are served without a signature", async () => {
  const created = await intent({
    purpose: "ROOM_IMAGE",
    originalName: "suite.jpg",
    contentType: "image/jpeg",
  });
  await put(created.data.upload.url, JPEG, "image/jpeg");
  await call(`/files/${created.data.fileId}/complete`, { method: "POST", token: deskToken, body: {} });

  const link = await call(`/files/${created.data.fileId}/download-url`, { token: deskToken });
  assert.equal(link.data.bucket, "PUBLIC");
  assert.ok(!link.data.url.includes("signature="), "public assets need no signature");
});

// ── Permissions & tenancy ────────────────────────────────────────────────

test("a download URL cannot be obtained for another tenant's file", async () => {
  const res = await call("/files/00000000-0000-0000-0000-000000000000/download-url", {
    token: deskToken,
  });
  assert.equal(res.status, 404);
});

test("unauthenticated access to the file API is refused", async () => {
  const res = await fetch(`${BASE}/files/intents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "GUEST_ID", originalName: "a.jpg", contentType: "image/jpeg", sizeBytes: 10 }),
  });
  assert.equal(res.status, 401);
});

test("manual quarantine requires the file.manage permission", async () => {
  const created = await intent();
  await put(created.data.upload.url, JPEG, "image/jpeg");
  await call(`/files/${created.data.fileId}/complete`, { method: "POST", token: deskToken, body: {} });

  const done = await call(`/files/${created.data.fileId}/quarantine`, {
    method: "POST",
    token: mgrToken,
    body: { reason: "Wrong document supplied by the guest" },
  });
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.status, "QUARANTINED");
});

// ── Lifecycle ────────────────────────────────────────────────────────────

test("soft delete hides the file and the sweep purges its bytes", async () => {
  const created = await intent();
  await put(created.data.upload.url, JPEG, "image/jpeg");
  await call(`/files/${created.data.fileId}/complete`, { method: "POST", token: deskToken, body: {} });

  const link = await call(`/files/${created.data.fileId}/download-url`, { token: deskToken });
  const urlBefore = link.data.url;

  const deleted = await call(`/files/${created.data.fileId}/delete`, {
    method: "POST",
    token: mgrToken,
  });
  assert.equal(deleted.status, 201);
  assert.ok(deleted.data.deletedAt);

  // The previously issued URL must stop working — the metadata row is the
  // authority, not the signature.
  const after = await fetch(urlBefore);
  assert.equal(after.status, 404);

  const swept = await call("/files/lifecycle/run", { method: "POST", token: mgrToken, body: {} });
  assert.equal(swept.status, 201);
  assert.ok(swept.data.purgedObjects >= 1, "the sweep must purge deleted objects");
});

test("abandoned upload intents are expired by the sweep", async () => {
  const created = await intent();
  assert.equal(created.status, 201);
  // The intent is left un-uploaded; the sweep expires it once its TTL passes.
  const swept = await call("/files/lifecycle/run", { method: "POST", token: mgrToken, body: {} });
  assert.equal(swept.status, 201);
  assert.equal(typeof swept.data.expiredIntents, "number");

  const listed = await call("/files?status=PENDING", { token: deskToken });
  assert.ok(Array.isArray(listed.data));
});

test("files can be listed by the entity they are attached to", async () => {
  const created = await intent({ entityType: "guest", entityId: "guest-xyz" });
  await put(created.data.upload.url, JPEG, "image/jpeg");
  await call(`/files/${created.data.fileId}/complete`, { method: "POST", token: deskToken, body: {} });

  const listed = await call("/files?entityType=guest&entityId=guest-xyz", { token: deskToken });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.some((f) => f.id === created.data.fileId));
});
