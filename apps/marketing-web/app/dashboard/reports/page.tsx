import { FileDown, TrendingUp, TrendingDown } from "lucide-react";
import { kpis, occupancyTrend, formatNaira } from "@/lib/data";

const reportRows = [
  { metric: "Room revenue", today: 1420000, mtd: 38400000, change: 12 },
  { metric: "Food & beverage", today: 424500, mtd: 8120000, change: 8 },
  { metric: "Other income", today: 62000, mtd: 1710000, change: -3 },
  { metric: "Discounts given", today: -45000, mtd: -960000, change: -15 },
  { metric: "Refunds", today: -46500, mtd: -412000, change: -22 },
];

const exports = [
  { name: "Daily Flash Report — 28 Jul 2026", type: "PDF" },
  { name: "Cashier Shift Summary — S-0411", type: "PDF" },
  { name: "Tax Summary — July 2026", type: "CSV" },
  { name: "Guest Ledger Export — July 2026", type: "CSV" },
];

export default function ReportsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Reports & Analytics
        </h1>
        <p className="mt-1 text-ink/55">
          Owner-level visibility: occupancy, revenue, discounts and exceptions.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Occupancy", value: `${kpis.occupancy}%` },
          { label: "ADR", value: formatNaira(kpis.adr) },
          { label: "RevPAR", value: formatNaira(kpis.revpar) },
          { label: "Revenue MTD", value: formatNaira(kpis.revenueMTD) },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm"
          >
            <p className="text-sm text-ink/50">{k.label}</p>
            <p className="mt-2 font-display text-3xl font-semibold text-ink">
              {k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm xl:col-span-2">
          <div className="px-7 py-5">
            <h2 className="font-semibold text-ink">Revenue summary</h2>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/60 text-xs text-ink/50">
                <th className="px-7 py-3.5 font-medium">Metric</th>
                <th className="px-4 py-3.5 text-right font-medium">Today</th>
                <th className="px-4 py-3.5 text-right font-medium">
                  Month to date
                </th>
                <th className="px-7 py-3.5 text-right font-medium">
                  vs last month
                </th>
              </tr>
            </thead>
            <tbody>
              {reportRows.map((r) => (
                <tr key={r.metric} className="border-t border-ink/5">
                  <td className="px-7 py-4 font-medium text-ink">{r.metric}</td>
                  <td
                    className={`px-4 py-4 text-right ${
                      r.today < 0 ? "text-red-500" : "text-ink/75"
                    }`}
                  >
                    {formatNaira(Math.abs(r.today))}
                    {r.today < 0 ? " –" : ""}
                  </td>
                  <td
                    className={`px-4 py-4 text-right ${
                      r.mtd < 0 ? "text-red-500" : "text-ink/75"
                    }`}
                  >
                    {formatNaira(Math.abs(r.mtd))}
                    {r.mtd < 0 ? " –" : ""}
                  </td>
                  <td className="px-7 py-4 text-right">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-semibold ${
                        r.change >= 0 ? "text-brand-600" : "text-red-500"
                      }`}
                    >
                      {r.change >= 0 ? (
                        <TrendingUp className="h-3.5 w-3.5" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5" />
                      )}
                      {Math.abs(r.change)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="border-t border-ink/5 px-7 py-6">
            <p className="mb-4 text-sm font-semibold text-ink">
              Occupancy — last 7 days
            </p>
            <div className="flex h-32 items-end gap-3">
              {occupancyTrend.map((d) => (
                <div
                  key={d.day}
                  className="flex flex-1 flex-col items-center gap-1.5"
                >
                  <div
                    className="w-full rounded-t-lg bg-brand-700/85"
                    style={{ height: `${d.value}%` }}
                  />
                  <span className="text-[10px] text-ink/45">{d.day}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <h2 className="font-semibold text-ink">Generated exports</h2>
          <p className="mt-1 text-xs text-ink/45">
            Reports are generated asynchronously and expire after 7 days.
          </p>
          <div className="mt-6 space-y-3">
            {exports.map((e) => (
              <button
                key={e.name}
                className="flex w-full items-center justify-between rounded-xl border border-ink/5 bg-cream/50 px-4 py-3.5 text-left transition-colors hover:border-brand-300"
              >
                <div>
                  <p className="text-sm font-medium text-ink">{e.name}</p>
                  <p className="text-[11px] text-ink/45">{e.type}</p>
                </div>
                <FileDown className="h-4.5 w-4.5 shrink-0 text-brand-700" />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
