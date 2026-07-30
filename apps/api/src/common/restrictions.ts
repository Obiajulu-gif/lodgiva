/**
 * §7 Rates and Availability — selling restriction evaluation.
 *
 * Pure and side-effect free so the rules can be unit-tested exhaustively
 * without a database. Every rejection carries a code the booking funnel can
 * turn into a specific message, because "not available" is the single most
 * expensive thing a booking engine can say without explaining why.
 */

export interface RestrictionRow {
  date: string;
  closed?: boolean;
  closedToArrival?: boolean;
  closedToDeparture?: boolean;
  minStay?: number | null;
  maxStay?: number | null;
  minAdvanceDays?: number | null;
}

export interface RestrictionViolation {
  code:
    | "DATES_CLOSED"
    | "CLOSED_TO_ARRIVAL"
    | "CLOSED_TO_DEPARTURE"
    | "MIN_STAY_NOT_MET"
    | "MAX_STAY_EXCEEDED"
    | "MIN_ADVANCE_NOT_MET";
  message: string;
  details: Record<string, unknown>;
}

export interface EvaluateInput {
  /** Stay nights: arrival inclusive, departure exclusive. */
  nights: string[];
  departureDate: string;
  /** Restrictions keyed by date. */
  restrictions: Map<string, RestrictionRow>;
  /** Plan-level default, used when a date carries no override. */
  planMinStay: number;
  /** Today, for advance-purchase rules. */
  businessDate: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/**
 * Returns every violation rather than the first, so a guest adjusting dates
 * is not sent round the loop repeatedly.
 */
export function evaluateRestrictions(input: EvaluateInput): RestrictionViolation[] {
  const violations: RestrictionViolation[] = [];
  const { nights, restrictions, departureDate, planMinStay, businessDate } = input;
  if (nights.length === 0) return violations;

  const arrival = nights[0];
  const stayLength = nights.length;

  // Closed for sale on any night in the stay.
  const closedNights = nights.filter((d) => restrictions.get(d)?.closed);
  if (closedNights.length) {
    violations.push({
      code: "DATES_CLOSED",
      message: `Not available on ${closedNights.join(", ")}.`,
      details: { dates: closedNights },
    });
  }

  // CTA applies to the arrival night only; CTD to the departure date itself.
  if (restrictions.get(arrival)?.closedToArrival) {
    violations.push({
      code: "CLOSED_TO_ARRIVAL",
      message: `Arrivals are not accepted on ${arrival}.`,
      details: { date: arrival },
    });
  }
  if (restrictions.get(departureDate)?.closedToDeparture) {
    violations.push({
      code: "CLOSED_TO_DEPARTURE",
      message: `Departures are not accepted on ${departureDate}.`,
      details: { date: departureDate },
    });
  }

  // Length-of-stay rules are anchored on the arrival date.
  const arrivalRule = restrictions.get(arrival);
  const minStay = arrivalRule?.minStay ?? planMinStay;
  if (minStay && stayLength < minStay) {
    violations.push({
      code: "MIN_STAY_NOT_MET",
      message: `A minimum stay of ${minStay} night(s) applies when arriving on ${arrival}.`,
      details: { minStay, requested: stayLength, date: arrival },
    });
  }
  const maxStay = arrivalRule?.maxStay ?? null;
  if (maxStay && stayLength > maxStay) {
    violations.push({
      code: "MAX_STAY_EXCEEDED",
      message: `A maximum stay of ${maxStay} night(s) applies when arriving on ${arrival}.`,
      details: { maxStay, requested: stayLength, date: arrival },
    });
  }

  const minAdvance = arrivalRule?.minAdvanceDays ?? null;
  if (minAdvance !== null && minAdvance !== undefined) {
    const lead = daysBetween(businessDate, arrival);
    if (lead < minAdvance) {
      violations.push({
        code: "MIN_ADVANCE_NOT_MET",
        message: `This rate must be booked at least ${minAdvance} day(s) ahead.`,
        details: { minAdvanceDays: minAdvance, leadDays: lead },
      });
    }
  }

  return violations;
}
