"use client";

import { useState } from "react";
import {
  Banknote,
  CheckCircle2,
  Clock4,
  MoonStar,
  AlertTriangle,
} from "lucide-react";
import { formatNaira } from "@/lib/data";

const shiftRows = [
  { label: "Opening float", amount: 50000 },
  { label: "Cash payments received", amount: 335000 },
  { label: "Cash refunds paid out", amount: -46500 },
  { label: "Cash deposits to safe", amount: -200000 },
];

const auditChecks = [
  { label: "All cashier shifts balanced", state: "pass" },
  { label: "Room charges posted for all occupied rooms", state: "pass" },
  { label: "No occupied rooms without active stays", state: "pass" },
  { label: "3 bank transfers pending verification", state: "warn" },
  { label: "No negative folio balances", state: "pass" },
  { label: "1 pending room move (Room 203 → 210)", state: "warn" },
];

export default function CashieringPage() {
  const [counted, setCounted] = useState("138500");
  const [auditRun, setAuditRun] = useState(false);

  const expected = shiftRows.reduce((s, r) => s + r.amount, 0);
  const countedNum = Number(counted.replace(/[^0-9]/g, "")) || 0;
  const variance = countedNum - expected;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Cashiering & Night Audit
        </h1>
        <p className="mt-1 text-ink/55">
          Balance the cash drawer, then close the business date.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* shift balancing */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold text-ink">
              <Banknote className="h-4 w-4 text-brand-700" />
              Shift #S-0412 — Front Desk
            </h2>
            <span className="flex items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">
              <Clock4 className="h-3.5 w-3.5" /> Open since 07:00
            </span>
          </div>

          <dl className="mt-6 space-y-3 text-sm">
            {shiftRows.map((r) => (
              <div key={r.label} className="flex justify-between">
                <dt className="text-ink/55">{r.label}</dt>
                <dd
                  className={
                    r.amount < 0 ? "text-red-500" : "font-medium text-ink"
                  }
                >
                  {r.amount < 0 ? "– " : ""}
                  {formatNaira(Math.abs(r.amount))}
                </dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-ink/10 pt-3">
              <dt className="font-semibold text-ink">Expected in drawer</dt>
              <dd className="font-display text-lg font-semibold text-brand-700">
                {formatNaira(expected)}
              </dd>
            </div>
          </dl>

          <div className="mt-6">
            <label className="text-xs font-semibold text-ink/60">
              COUNTED CASH
            </label>
            <input
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              inputMode="numeric"
              className="mt-2 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none focus:border-brand-500"
            />
            <div
              className={`mt-3 flex items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold ${
                variance === 0
                  ? "bg-brand-50 text-brand-700"
                  : "bg-red-50 text-red-600"
              }`}
            >
              <span>Variance</span>
              <span>
                {variance === 0
                  ? "Balanced ✓"
                  : `${variance > 0 ? "+" : "–"} ${formatNaira(Math.abs(variance))}`}
              </span>
            </div>
            {variance !== 0 && (
              <p className="mt-2 text-xs text-ink/50">
                Closing with a variance requires manager approval and a reason
                — it will appear in the audit log.
              </p>
            )}
            <button className="mt-4 w-full rounded-full bg-brand-800 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700">
              Close shift{variance !== 0 ? " (request approval)" : ""}
            </button>
          </div>
        </div>

        {/* night audit */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <MoonStar className="h-4 w-4 text-brand-700" />
            Night audit — business date 28 Jul 2026
          </h2>

          <div className="mt-6 space-y-3">
            {auditChecks.map((c) => (
              <div
                key={c.label}
                className="flex items-center gap-3 rounded-xl border border-ink/5 bg-cream/50 px-4 py-3 text-sm"
              >
                {c.state === "pass" ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-brand-600" />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-gold-500" />
                )}
                <span className="text-ink/70">{c.label}</span>
              </div>
            ))}
          </div>

          {auditRun ? (
            <div className="mt-6 rounded-xl bg-brand-50 p-5 text-center">
              <p className="font-semibold text-brand-800">
                Night audit completed ✓
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink/60">
                Room revenue posted · KPIs snapshotted · Business date advanced
                to <strong>29 Jul 2026</strong>. The audit is idempotent — a
                rerun cannot post twice.
              </p>
            </div>
          ) : (
            <>
              <p className="mt-5 text-xs leading-relaxed text-ink/50">
                Running the audit posts daily room charges, closes eligible
                folios and shifts, snapshots KPIs and advances the business
                date. Warnings can be acknowledged with a reason.
              </p>
              <button
                onClick={() => setAuditRun(true)}
                className="mt-4 w-full rounded-full bg-gold-400 py-3.5 text-sm font-semibold text-brand-950 transition-colors hover:bg-gold-300"
              >
                Run night audit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
