/**
 * §6.4 authorisation model — RBAC plus resource scope.
 *
 * Roles are bundles of permissions; membership defines tenant and property
 * scope. Keeping the matrix in one table (rather than `role === "X"` checks
 * scattered through services) means an auditor can read the whole access
 * model on one screen, and adding a role cannot silently widen access
 * somewhere unrelated.
 */

export const PERMISSIONS = [
  // Reservations & front office
  "reservation.read",
  "reservation.create",
  "reservation.modify",
  "reservation.cancel",
  "reservation.override_rate",
  "frontdesk.check_in",
  "frontdesk.check_out",
  "frontdesk.room_move",
  // Guests
  "guest.read",
  "guest.manage",
  "file.manage",
  "file.manage",
  // Folio & money
  "folio.read",
  "folio.post_charge",
  "folio.apply_discount",
  "folio.reverse_entry",
  "payment.capture",
  "payment.refund",
  "cashier.open_shift",
  "cashier.close_shift",
  "cashier.approve_variance",
  "pos.operate",
  // Operations
  "housekeeping.read",
  "housekeeping.update",
  "maintenance.read",
  "maintenance.manage",
  "room.block",
  // Nightly & reporting
  "night_audit.run",
  "report.operational.read",
  "report.financial.read",
  "audit.read",
  // Configuration & administration
  "settings.property.manage",
  "settings.room.manage",
  "settings.rate.manage",
  "settings.tax.manage",
  "approval.decide",
  "user.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "TENANT_OWNER",
  "GENERAL_MANAGER",
  "FRONT_DESK",
  "CASHIER",
  "HOUSEKEEPING",
  "MAINTENANCE",
  "FINANCE",
  "AUDITOR",
] as const;

export type Role = (typeof ROLES)[number];

const READ_ONLY: Permission[] = [
  "reservation.read",
  "guest.read",
  "folio.read",
  "housekeeping.read",
  "maintenance.read",
  "report.operational.read",
  "report.financial.read",
  "audit.read",
];

/**
 * Tenant Owner deliberately does NOT get every permission: the spec is
 * explicit that no role may alter immutable audit history, and day-to-day
 * operational permissions (check-in, POS) are not an owner's job. Owners can
 * always grant themselves an operational role if they work the desk.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  TENANT_OWNER: [
    ...READ_ONLY,
    "reservation.create",
    "reservation.modify",
    "reservation.cancel",
    "reservation.override_rate",
    "folio.apply_discount",
    "payment.refund",
    "cashier.approve_variance",
    "night_audit.run",
    "room.block",
    "settings.property.manage",
    "settings.room.manage",
    "settings.rate.manage",
    "settings.tax.manage",
    "approval.decide",
    "user.manage",
  ],
  GENERAL_MANAGER: [
    ...READ_ONLY,
    "reservation.create",
    "reservation.modify",
    "reservation.cancel",
    "reservation.override_rate",
    "frontdesk.check_in",
    "frontdesk.check_out",
    "frontdesk.room_move",
    "guest.manage",
    "file.manage",
    "folio.post_charge",
    "folio.apply_discount",
    "folio.reverse_entry",
    "payment.capture",
    "payment.refund",
    "cashier.open_shift",
    "cashier.close_shift",
    "cashier.approve_variance",
    "pos.operate",
    "housekeeping.update",
    "maintenance.manage",
    "room.block",
    "night_audit.run",
    "settings.property.manage",
    "settings.room.manage",
    "settings.rate.manage",
    "approval.decide",
    "user.manage",
  ],
  // No tax or role configuration, per §6.4.
  FRONT_DESK: [
    "reservation.read",
    "reservation.create",
    "reservation.modify",
    "reservation.cancel",
    "guest.read",
    "guest.manage",
    "file.manage",
    "frontdesk.check_in",
    "frontdesk.check_out",
    "frontdesk.room_move",
    "folio.read",
    "folio.post_charge",
    "folio.apply_discount",
    "payment.capture",
    "cashier.open_shift",
    "cashier.close_shift",
    "pos.operate",
    "housekeeping.read",
    "maintenance.read",
    "maintenance.manage",
    "report.operational.read",
  ],
  // Refunds and voids require approval, so no payment.refund here.
  CASHIER: [
    "reservation.read",
    "guest.read",
    "folio.read",
    "folio.post_charge",
    "payment.capture",
    "cashier.open_shift",
    "cashier.close_shift",
    "pos.operate",
    "report.operational.read",
  ],
  // No guest financial data beyond operational need: no folio.read.
  HOUSEKEEPING: [
    "housekeeping.read",
    "housekeeping.update",
    "maintenance.read",
    "maintenance.manage",
    "reservation.read",
  ],
  MAINTENANCE: [
    "maintenance.read",
    "maintenance.manage",
    "housekeeping.read",
    "room.block",
  ],
  FINANCE: [
    ...READ_ONLY,
    "folio.post_charge",
    "folio.reverse_entry",
    "folio.apply_discount",
    "payment.capture",
    "payment.refund",
    "cashier.approve_variance",
    "approval.decide",
    "settings.tax.manage",
  ],
  // Read-only by definition (§6.4).
  AUDITOR: [...READ_ONLY],
};

const ROLE_SET: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => [role, new Set<string>(perms)])
);

export function roleHasPermission(role: string, permission: Permission): boolean {
  return ROLE_SET[role]?.has(permission) ?? false;
}

export function permissionsForRole(role: string): Permission[] {
  return [...(ROLE_SET[role] ?? new Set<string>())] as Permission[];
}
