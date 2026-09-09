import test from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  roleHasPermission,
  permissionsForRole,
} from "../../dist/common/permissions.js";

test("every role grants only permissions from the catalogue", () => {
  const catalogue = new Set(PERMISSIONS);
  for (const role of ROLES) {
    for (const perm of ROLE_PERMISSIONS[role]) {
      assert.ok(catalogue.has(perm), `${role} grants unknown permission "${perm}"`);
    }
  }
});

test("every role in the catalogue has an entry in the matrix", () => {
  for (const role of ROLES) {
    assert.ok(Array.isArray(ROLE_PERMISSIONS[role]), `${role} has no permission list`);
  }
});

test("an unknown role has no permissions at all (fails closed)", () => {
  assert.equal(roleHasPermission("SUPERUSER", "user.manage"), false);
  assert.equal(roleHasPermission("", "reservation.read"), false);
  assert.deepEqual(permissionsForRole("NOPE"), []);
});

test("AUDITOR is strictly read-only", () => {
  for (const perm of permissionsForRole("AUDITOR")) {
    assert.ok(perm.endsWith(".read"), `AUDITOR must not hold write permission "${perm}"`);
  }
});

test("no role can manage users except owner and general manager", () => {
  const canManage = ROLES.filter((r) => roleHasPermission(r, "user.manage"));
  assert.deepEqual(canManage.sort(), ["GENERAL_MANAGER", "TENANT_OWNER"]);
});

test("only finance-grade roles may change tax configuration (§6.4)", () => {
  const canTax = ROLES.filter((r) => roleHasPermission(r, "settings.tax.manage"));
  assert.deepEqual(canTax.sort(), ["FINANCE", "TENANT_OWNER"]);
  // Explicitly asserted because the spec calls it out: front desk must not.
  assert.equal(roleHasPermission("FRONT_DESK", "settings.tax.manage"), false);
});

test("cashier cannot refund — refunds require approval (§6.4)", () => {
  assert.equal(roleHasPermission("CASHIER", "payment.refund"), false);
  assert.equal(roleHasPermission("CASHIER", "payment.capture"), true);
});

test("housekeeping has no access to guest financial data", () => {
  assert.equal(roleHasPermission("HOUSEKEEPING", "folio.read"), false);
  assert.equal(roleHasPermission("HOUSEKEEPING", "payment.capture"), false);
  assert.equal(roleHasPermission("HOUSEKEEPING", "housekeeping.update"), true);
});

test("a cashier cannot approve their own variance category", () => {
  assert.equal(roleHasPermission("CASHIER", "cashier.approve_variance"), false);
  assert.equal(roleHasPermission("GENERAL_MANAGER", "cashier.approve_variance"), true);
});

test("no role is granted every permission", () => {
  for (const role of ROLES) {
    assert.notEqual(
      permissionsForRole(role).length,
      PERMISSIONS.length,
      `${role} holds every permission; least privilege is not being applied`
    );
  }
});

test("every role that can create a reservation can also create a guest", () => {
  // POST /reservations requires a guestId, so reservation.create without
  // guest.manage is a permission the holder can never actually use. This bit
  // a brand-new self-serve owner hardest: the only user in the tenant, unable
  // to take a first booking until they invited a colleague.
  for (const role of ROLES) {
    if (!roleHasPermission(role, "reservation.create")) continue;
    assert.equal(
      roleHasPermission(role, "guest.manage"),
      true,
      `${role} can create reservations but cannot create the guest one needs`
    );
  }
});

test("a role that can take a booking can carry it through the whole stay", () => {
  // Creating a reservation nobody can check in, charge, or check out is a
  // dead end. It bit the self-serve owner hardest: the only user in a new
  // tenant, holding reservation.create and nothing that could follow it.
  const stay = [
    "frontdesk.check_in",
    "folio.post_charge",
    "payment.capture",
    "frontdesk.check_out",
  ];
  for (const role of ROLES) {
    if (!roleHasPermission(role, "reservation.create")) continue;
    for (const step of stay) {
      assert.equal(
        roleHasPermission(role, step),
        true,
        `${role} can create a reservation but cannot ${step} — the booking dead-ends`
      );
    }
  }
});

test("the owner still cannot open, take and close their own cash drawer", () => {
  // Granting the owner the operational set above deliberately stopped short of
  // cash handling. The shift is the reconciliation unit, and one person who
  // opens it, takes the money and closes it has removed the only check on it.
  for (const granted of ["reservation.create", "guest.manage", "user.manage"]) {
    assert.equal(roleHasPermission("TENANT_OWNER", granted), true, granted);
  }
  for (const withheld of ["pos.operate", "cashier.open_shift", "cashier.close_shift"]) {
    assert.equal(
      roleHasPermission("TENANT_OWNER", withheld),
      false,
      `${withheld} must stay out of the owner role`
    );
  }
});
