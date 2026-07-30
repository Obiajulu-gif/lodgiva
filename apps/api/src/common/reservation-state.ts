/**
 * §7.1 reservation lifecycle, expressed as data rather than as scattered
 * `if` statements, so the legal transitions can be read in one place and
 * tested exhaustively without a database.
 */

export const RESERVATION_STATES = [
  "DRAFT",
  "HOLD",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "CANCELLED",
  "NO_SHOW",
] as const;

export type ReservationState = (typeof RESERVATION_STATES)[number];

export const TRANSITIONS: Record<ReservationState, ReservationState[]> = {
  DRAFT: ["HOLD", "PENDING_PAYMENT", "CONFIRMED", "CANCELLED"],
  HOLD: ["PENDING_PAYMENT", "CONFIRMED", "CANCELLED"],
  PENDING_PAYMENT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["CHECKED_OUT"],
  // Terminal: money and inventory consequences are already settled.
  CHECKED_OUT: [],
  CANCELLED: [],
  NO_SHOW: [],
};

/** States that hold inventory and must release it when they end. */
export const INVENTORY_HOLDING_STATES: ReservationState[] = [
  "HOLD",
  "PENDING_PAYMENT",
  "CONFIRMED",
  "CHECKED_IN",
];

/** States a guest can still have their stay details changed in. */
export const MODIFIABLE_STATES: ReservationState[] = [
  "DRAFT",
  "HOLD",
  "PENDING_PAYMENT",
  "CONFIRMED",
];

export const TERMINAL_STATES: ReservationState[] = RESERVATION_STATES.filter(
  (s) => TRANSITIONS[s].length === 0
);

export function isTerminal(state: ReservationState): boolean {
  return TRANSITIONS[state].length === 0;
}

export function canTransition(from: ReservationState, to: ReservationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function holdsInventory(state: ReservationState): boolean {
  return INVENTORY_HOLDING_STATES.includes(state);
}

export function isModifiable(state: ReservationState): boolean {
  return MODIFIABLE_STATES.includes(state);
}

/**
 * A human-readable reason a transition is illegal. Front desk staff act on
 * these messages under pressure, so they say what to do instead.
 */
export function explainRejection(
  from: ReservationState,
  to: ReservationState
): string {
  if (from === to) return `The reservation is already ${from.replace("_", " ").toLowerCase()}.`;
  if (isTerminal(from)) {
    return `This reservation is ${from.replace("_", " ").toLowerCase()} and cannot change state again.`;
  }
  if (from === "CHECKED_IN" && to === "CANCELLED") {
    return "An in-house guest cannot be cancelled — check them out instead.";
  }
  if (from === "CONFIRMED" && to === "CHECKED_OUT") {
    return "The guest must be checked in before they can be checked out.";
  }
  if (to === "NO_SHOW" && from !== "CONFIRMED") {
    return "Only a confirmed reservation can be marked as a no-show.";
  }
  const legal = TRANSITIONS[from];
  return legal.length
    ? `Cannot move a reservation from ${from} to ${to}. Allowed from here: ${legal.join(", ")}.`
    : `Cannot move a reservation from ${from} to ${to}.`;
}
