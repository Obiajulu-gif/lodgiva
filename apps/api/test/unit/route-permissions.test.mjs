/**
 * Every mutating route must say who may call it.
 *
 * PermissionsGuard allows a route that declares no permission — deliberately,
 * because permissions gate *actions* while tenant scoping gates *data*. The
 * consequence is that forgetting a decorator does not fail loudly, it fails
 * open. That is exactly how FoliosController and PaymentsController came to be
 * callable by any authenticated account, a housekeeper included.
 *
 * This test closes the class of bug rather than the two instances. A new
 * POST/PATCH/PUT/DELETE route either declares a permission, or is listed below
 * with a reason a reviewer agreed to. There is no third option, and adding a
 * route without doing one of those fails the build.
 *
 * It reads the source rather than booting Nest: a test that needs a database
 * to tell you your authorisation metadata is missing is a test that stops
 * being run.
 *
 * Run: node --test test/unit/route-permissions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MODULES = join(dirname(fileURLToPath(import.meta.url)), "../../src/modules");

/**
 * Routes that intentionally carry no permission, each with the reason.
 *
 * Keyed `file:METHOD handlerName`. Keep this list short and argue for every
 * entry — it is the escape hatch, so it is also the thing to review first.
 */
const NO_PERMISSION_REQUIRED = {
  // Authentication: the caller has no session yet, or is acting on their own
  // account. A permission check here would be circular.
  "auth.module.ts:POST login": "public — establishes the session",
  "auth.module.ts:POST refresh": "public — rotates the caller's own session",
  "auth.module.ts:POST logout": "acts on the caller's own session",
  "auth.module.ts:POST mfaVerify": "public — completes the caller's own sign-in",
  "auth.module.ts:POST mfaEnrolSetup": "public — carries its own single-purpose token",
  "auth.module.ts:POST mfaEnrolActivate": "public — carries its own single-purpose token",
  "auth.module.ts:POST mfaSetup": "the caller's own second factor",
  "auth.module.ts:POST mfaActivate": "the caller's own second factor",
  "auth.module.ts:POST mfaDisable": "the caller's own second factor; re-proves the password",
  "auth.module.ts:DELETE revokeSession": "the caller's own sessions",
  "auth.module.ts:DELETE revokeAll": "the caller's own sessions",

  // Onboarding: public by design, rate limited, and creates the tenant that
  // any permission would have had to be checked against.
  "admin.module.ts:POST onboard": "public — creates the tenant itself",

  // Provider ingress: authenticated by HMAC over the raw body, not by a
  // session. A provider is not a user and holds no role.
  "gateway.module.ts:POST webhook": "signature-verified provider ingress",

  // Self-service device registration, scoped to the calling user.
  "push.module.ts:POST subscribe": "registers the caller's own device",
  "push.module.ts:POST unsubscribe": "removes the caller's own device",
  "push.module.ts:POST test": "sends only to the caller's own devices",

  // Offline queue: every mutation inside the envelope is re-authorised
  // individually by the service, which is where the real check belongs.
  "sync.module.ts:POST push": "each queued mutation is authorised on apply",

  // Gateway money routes enforced by an APPROVER_ROLES allow-list in the
  // service (owner / GM / finance), verified by reading each one. Declared
  // here so the exception is visible rather than implicit -- these are the
  // routes that move money OUT, so the reason has to be on the record.
  "gateway.module.ts:POST approveRefund": "service restricts to APPROVER_ROLES",
  "gateway.module.ts:POST rejectRefund": "service restricts to APPROVER_ROLES",
  "gateway.module.ts:POST importSettlement": "service restricts to APPROVER_ROLES",
  "gateway.module.ts:POST importSettlementCsv": "service restricts to APPROVER_ROLES",
  "gateway.module.ts:POST resolveException": "service restricts to APPROVER_ROLES",

  // Enforced in the service or controller body rather than by metadata.
  // Verified by reading each one; noted so the exception is visible.
  "approvals.module.ts:POST requestDiscount": "service checks approval.decide for self-service limit",
  "approvals.module.ts:POST approve": "service enforces approval.decide and separation of duties",
  "approvals.module.ts:POST reject": "service enforces approval.decide and separation of duties",
  "platform.module.ts:PUT setPolicy": "service asserts user.manage",
  "platform.module.ts:POST create": "controller asserts account owner",
  "platform.module.ts:PUT update": "controller asserts account owner",
};

const MUTATING = ["Post", "Patch", "Put", "Delete"];

/** Collects mutating routes and the decorators attached to each. */
function scan(file) {
  const src = readFileSync(join(MODULES, file), "utf8");
  const lines = src.split("\n");
  const routes = [];

  // Only look inside controllers; services have methods that look similar but
  // are not routes.
  let inController = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^@Controller\(/.test(lines[i])) inController = true;
    if (/^@(Injectable|Module)\(/.test(lines[i])) inController = false;
    if (!inController) continue;

    const verb = MUTATING.find((v) => new RegExp(`^\\s+@${v}\\(`).test(lines[i]));
    if (!verb) continue;

    // A method's decorators may sit either side of the route decorator, in any
    // order: this codebase writes `@Post()` then `@RequirePermission(...)`,
    // and an earlier version of this scanner only looked upward — which
    // reported twenty-seven correctly-guarded routes as wide open. Collect the
    // whole contiguous decorator block, both directions.
    const decorators = [lines[i].trim()];
    for (let up = i - 1; up >= 0; up--) {
      const line = lines[up].trim();
      if (line.startsWith("@")) decorators.push(line);
      else if (line === "" || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*") || line.startsWith("*/")) continue;
      else break;
    }

    let handler = "unknown";
    for (let down = i + 1; down < lines.length; down++) {
      const line = lines[down].trim();
      if (line.startsWith("@")) {
        decorators.push(line);
        continue;
      }
      if (line === "" || line.startsWith("//") || line.startsWith("*")) continue;
      const m = /^(?:async\s+)?([A-Za-z_][\w]*)\s*\(/.exec(line);
      if (m) handler = m[1];
      break;
    }

    const hasPermission = decorators.some((d) => d.startsWith("@RequirePermission("));
    const isPublic = decorators.some((d) => d.startsWith("@Public("));

    routes.push({ file, verb: verb.toUpperCase(), handler, hasPermission, isPublic });
  }
  return routes;
}

const files = readdirSync(MODULES).filter((f) => f.endsWith(".module.ts"));
const allRoutes = files.flatMap(scan);

test("the scanner actually found the routes", () => {
  // A scanner that silently matches nothing would make every assertion below
  // vacuously true — the most dangerous kind of passing test.
  assert.ok(allRoutes.length > 50, `expected to find many mutating routes, found ${allRoutes.length}`);
  const withPermission = allRoutes.filter((r) => r.hasPermission);
  assert.ok(
    withPermission.length > 20,
    `expected to detect existing @RequirePermission decorators, found ${withPermission.length}`
  );
});

test("every mutating route declares a permission or is an agreed exception", () => {
  const undeclared = allRoutes
    .filter((r) => !r.hasPermission && !r.isPublic)
    .filter((r) => !(`${r.file}:${r.verb} ${r.handler}` in NO_PERMISSION_REQUIRED));

  assert.deepEqual(
    undeclared.map((r) => `${r.file}:${r.verb} ${r.handler}`),
    [],
    "These mutating routes are callable by any authenticated account. Add " +
      "@RequirePermission, or add an entry to NO_PERMISSION_REQUIRED with the " +
      "reason. Failing open is how a housekeeper came to be able to post charges."
  );
});

test("the exception list has no stale entries", () => {
  // A reason left behind for a route that no longer exists is a reason nobody
  // will re-examine, and it quietly widens the next matching handler name.
  const present = new Set(allRoutes.map((r) => `${r.file}:${r.verb} ${r.handler}`));
  const stale = Object.keys(NO_PERMISSION_REQUIRED).filter((k) => !present.has(k));
  assert.deepEqual(stale, [], "remove these — the routes are gone or renamed");
});

test("money routes are never on the exception list", () => {
  // Whatever else is argued, nothing that touches a folio, a payment or the
  // business day may be authorised by omission.
  const protectedFiles = [
    "folios.module.ts",
    "payments.module.ts",
    "invoices.module.ts",
    "cashiering.module.ts",
    "night-audit.module.ts",
  ];
  for (const key of Object.keys(NO_PERMISSION_REQUIRED)) {
    const file = key.split(":")[0];
    assert.ok(
      !protectedFiles.includes(file),
      `${key} must declare a permission outright, not be excepted`
    );
  }
  for (const route of allRoutes.filter((r) => protectedFiles.includes(r.file))) {
    assert.equal(
      route.hasPermission,
      true,
      `${route.file}:${route.verb} ${route.handler} moves money and must declare a permission`
    );
  }
});
