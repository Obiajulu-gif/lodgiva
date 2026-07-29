import {
  BedDouble,
  Wallet,
  TrendingUp,
  Users,
  ArrowUpRight,
  AlertTriangle,
} from "lucide-react";
import {
  kpis,
  occupancyTrend,
  revenueByOutlet,
  reservations,
  formatNaira,
} from "@/lib/data";

const statusStyles: Record<string, string> = {
  CHECKED_IN: "bg-brand-100 text-brand-800",
  CONFIRMED: "bg-blue-50 text-blue-700",
  PENDING_PAYMENT: "bg-gold-100 text-gold-600",
  CHECKED_OUT: "bg-ink/5 text-ink/50",
  CANCELLED: "bg-red-50 text-red-600",
  NO_SHOW: "bg-red-50 text-red-600",
};

export default function DashboardOverview() {
  const maxOutlet = Math.max(...revenueByOutlet.map((r) => r.value));
  const today = reservations.filter((r) =>
    ["CHECKED_IN", "CONFIRMED", "PENDING_PAYMENT"].includes(r.status)
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Good afternoon, Manager
        </h1>
        <p className="mt-1 text-ink/55">
          Here&apos;s how Grand Palm Hotel is performing today.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            icon: BedDouble,
            label: "Occupancy",
            value: `${kpis.occupancy}%`,
            sub: `${kpis.roomsSold} of ${kpis.totalRooms} rooms sold`,
            delta: "+6% vs last week",
          },
          {
            icon: Wallet,
            label: "Revenue today",
            value: formatNaira(kpis.revenueToday),
            sub: `MTD ${formatNaira(kpis.revenueMTD)}`,
            delta: "+18% vs last week",
          },
          {
            icon: TrendingUp,
            label: "ADR / RevPAR",
            value: formatNaira(kpis.adr),
            sub: `RevPAR ${formatNaira(kpis.revpar)}`,
            delta: "+4% vs last week",
          },
          {
            icon: Users,
            label: "Movements today",
            value: `${kpis.arrivalsToday} in · ${kpis.departuresToday} out`,
            sub: `${kpis.inHouse} guests in-house`,
            delta: "On schedule",
          },
        ].map((k) => (
          <div
            key={k.label}
            className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
                <k.icon className="h-5 w-5" />
              </span>
              <span className="flex items-center gap-1 text-xs font-semibold text-brand-600">
                <ArrowUpRight className="h-3.5 w-3.5" />
                {k.delta}
              </span>
            </div>
            <p className="mt-5 text-sm text-ink/50">{k.label}</p>
            <p className="mt-1 font-display text-2xl font-semibold text-ink">
              {k.value}
            </p>
            <p className="mt-1 text-xs text-ink/45">{k.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* occupancy chart */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm xl:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-ink">Occupancy this week</h2>
            <span className="text-xs text-ink/45">Jul 22 – Jul 28</span>
          </div>
          <div className="mt-8 flex h-56 items-end gap-4">
            {occupancyTrend.map((d) => (
              <div key={d.day} className="flex flex-1 flex-col items-center gap-2">
                <span className="text-xs font-semibold text-ink/60">
                  {d.value}%
                </span>
                <div
                  className={`w-full rounded-t-xl ${
                    d.day === "Sun" ? "bg-gold-400" : "bg-brand-700"
                  }`}
                  style={{ height: `${d.value * 2}px` }}
                />
                <span className="text-xs text-ink/45">{d.day}</span>
              </div>
            ))}
          </div>
        </div>

        {/* revenue by outlet */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <h2 className="font-semibold text-ink">Revenue by outlet — today</h2>
          <div className="mt-7 space-y-5">
            {revenueByOutlet.map((o) => (
              <div key={o.outlet}>
                <div className="flex justify-between text-sm">
                  <span className="text-ink/70">{o.outlet}</span>
                  <span className="font-semibold text-ink">
                    {formatNaira(o.value)}
                  </span>
                </div>
                <div className="mt-2 h-2 rounded-full bg-brand-50">
                  <div
                    className="h-2 rounded-full bg-brand-600"
                    style={{ width: `${(o.value / maxOutlet) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-gold-200 bg-gold-100/50 p-4">
            <p className="flex items-center gap-2 text-sm font-semibold text-gold-600">
              <AlertTriangle className="h-4 w-4" />
              Needs attention
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-ink/60">
              {kpis.pendingReconciliation} bank transfers pending
              reconciliation · Outstanding balances{" "}
              {formatNaira(kpis.outstandingBalance)}
            </p>
          </div>
        </div>
      </div>

      {/* today's reservations */}
      <div className="rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="flex items-center justify-between px-7 py-5">
          <h2 className="font-semibold text-ink">Active reservations</h2>
          <span className="text-xs text-ink/45">{today.length} records</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-t border-ink/5 bg-cream/60 text-xs text-ink/50">
                <th className="px-7 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Guest</th>
                <th className="px-4 py-3 font-medium">Room</th>
                <th className="px-4 py-3 font-medium">Arrival → Departure</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-7 py-3 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {today.map((r) => (
                <tr key={r.id} className="border-t border-ink/5">
                  <td className="px-7 py-4 font-mono text-xs text-brand-700">
                    {r.code}
                  </td>
                  <td className="px-4 py-4 font-medium text-ink">{r.guest}</td>
                  <td className="px-4 py-4 text-ink/60">
                    {r.room} · {r.roomType}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {r.arrival} → {r.departure}
                  </td>
                  <td className="px-4 py-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusStyles[r.status]}`}
                    >
                      {r.status.replace("_", " ")}
                    </span>
                  </td>
                  <td
                    className={`px-7 py-4 text-right font-semibold ${
                      r.balance > 0 ? "text-gold-600" : "text-brand-600"
                    }`}
                  >
                    {r.balance > 0 ? formatNaira(r.balance) : "Paid"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
