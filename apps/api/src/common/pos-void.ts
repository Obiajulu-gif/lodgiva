/**
 * §13.4 — when a POS void needs a supervisor.
 *
 * Kept as a pure function because the interesting cases are a clock and a
 * threshold: an order that has aged past the correction window cannot be
 * produced in an integration test without waiting fifteen real minutes, and a
 * rule that is only exercised through HTTP is a rule nobody tests.
 */

/**
 * A waiter keying the wrong table should not need a manager for a small
 * mistake spotted immediately. Larger or older voids are where till theft
 * hides: ring the order, take the cash, void the ticket, keep the difference.
 */
export const POS_VOID_SELF_SERVICE_MINOR = 500_000; // ₦5,000
export const POS_VOID_GRACE_MINUTES = 15;

export interface VoidDecision {
  requiresApproval: boolean;
  /** Shown to the requester so the rule is never a mystery. */
  message: string | null;
}

export function decideVoid(input: {
  totalMinor: number;
  ageMinutes: number;
  /** True when the actor holds approval.decide. */
  canApprove: boolean;
}): VoidDecision {
  // Someone who could approve the request anyway does not raise one against
  // themselves — that is theatre, not control. Their name is still on the
  // audit entry, which is what the control actually rests on.
  if (input.canApprove) return { requiresApproval: false, message: null };

  const tooLarge = input.totalMinor > POS_VOID_SELF_SERVICE_MINOR;
  const tooOld = input.ageMinutes > POS_VOID_GRACE_MINUTES;

  if (!tooLarge && !tooOld) return { requiresApproval: false, message: null };

  // Both conditions can hold at once; lead with the amount, because that is
  // the number the supervisor will ask about first.
  if (tooLarge) {
    return {
      requiresApproval: true,
      message: `Voids above ₦${(POS_VOID_SELF_SERVICE_MINOR / 100).toLocaleString("en-NG")} need a supervisor.`,
    };
  }
  return {
    requiresApproval: true,
    message: `This order was opened ${Math.round(input.ageMinutes)} minutes ago, past the ${POS_VOID_GRACE_MINUTES}-minute correction window. A supervisor must approve the void.`,
  };
}
