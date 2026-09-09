import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";

type Tx = Prisma.TransactionClient;

export interface ResolvedTaxLine {
  code: string;
  name: string;
  amountMinor: bigint;
  taxRuleId: string;
  taxRuleVersion: number;
  isServiceCharge: boolean;
}

export interface TaxComputation {
  base: bigint;
  lines: ResolvedTaxLine[];
  total: bigint;
}

// Fallback used when a property has no configured rules yet (§13.3 defaults
// for Nigeria: 5% service charge, then 7.5% VAT on base + service).
const FALLBACK = [
  { code: "SVC", name: "Service Charge", rateBp: 500, compoundOrder: 1, taxOnServiceCharge: false },
  { code: "VAT", name: "Value Added Tax", rateBp: 750, compoundOrder: 2, taxOnServiceCharge: true },
];

/**
 * §13.3 tax engine. Rules are versioned by effective date and scoped by
 * charge type; the resolved rule id + version is returned so the caller can
 * persist it on the folio line.
 */
@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param chargeKind ROOM or FB — rules scoped to the other kind are skipped.
   * @param businessDate the date whose rule versions apply.
   */
  async compute(
    tx: Tx | PrismaService,
    input: {
      tenantId: string;
      propertyId: string;
      baseMinor: bigint;
      chargeKind: "ROOM" | "FB";
      businessDate: string;
    }
  ): Promise<TaxComputation> {
    const rules = await tx.taxRule.findMany({
      where: {
        tenantId: input.tenantId,
        propertyId: input.propertyId,
        effectiveFrom: { lte: input.businessDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: input.businessDate } }],
        appliesTo: { in: ["ALL", input.chargeKind] },
      },
      orderBy: [{ compoundOrder: "asc" }, { version: "desc" }],
    });

    // Keep only the newest effective version of each code.
    const active = new Map<string, (typeof rules)[number]>();
    for (const r of rules) {
      const seen = active.get(r.code);
      if (!seen || r.version > seen.version) active.set(r.code, r);
    }
    const ordered = [...active.values()].sort((a, b) => a.compoundOrder - b.compoundOrder);

    const lines: ResolvedTaxLine[] = [];
    let serviceChargeMinor = 0n;
    /** Tax already contained in baseMinor, for INCLUSIVE rules. */
    let includedTaxMinor = 0n;

    if (ordered.length === 0) {
      // No configured rules — apply the documented defaults so billing still
      // works on a freshly onboarded property.
      for (const f of FALLBACK) {
        const taxable = f.taxOnServiceCharge ? input.baseMinor + serviceChargeMinor : input.baseMinor;
        const amount = (taxable * BigInt(f.rateBp)) / 10000n;
        const isSvc = f.code === "SVC";
        if (isSvc) serviceChargeMinor = amount;
        lines.push({
          code: f.code,
          name: f.name,
          amountMinor: amount,
          taxRuleId: `default:${f.code}`,
          taxRuleVersion: 0,
          isServiceCharge: isSvc,
        });
      }
    } else {
      for (const rule of ordered) {
        const isSvc = rule.code === "SVC";
        const taxable =
          rule.taxOnServiceCharge && !isSvc
            ? input.baseMinor + serviceChargeMinor
            : input.baseMinor;
        // Inclusive pricing extracts the tax out of the base rather than adding to it.
        const amount =
          rule.basis === "INCLUSIVE"
            ? (taxable * BigInt(rule.rateBp)) / BigInt(10000 + rule.rateBp)
            : (taxable * BigInt(rule.rateBp)) / 10000n;
        // An inclusive rule takes its tax OUT of the price the guest was
        // quoted; it must not also be added on top. Tracking the extracted
        // amount here is what keeps the quoted price and the ledger total
        // equal — previously ₦107,500 inclusive of 7.5% was billed as
        // ₦115,000, overcharging every guest on an inclusive rule.
        if (rule.basis === "INCLUSIVE") includedTaxMinor += amount;
        if (isSvc) serviceChargeMinor = amount;
        lines.push({
          code: rule.code,
          name: rule.name,
          amountMinor: amount,
          taxRuleId: rule.id,
          taxRuleVersion: rule.version,
          isServiceCharge: isSvc,
        });
      }
    }

    // The charge line carries the price NET of anything already inside it, so
    // base + every component reconciles exactly to what the guest was quoted.
    const netBase = input.baseMinor - includedTaxMinor;
    const total = netBase + lines.reduce((s, l) => s + l.amountMinor, 0n);
    return { base: netBase, lines, total };
  }
}
