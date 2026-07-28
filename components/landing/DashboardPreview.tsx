import { BedDouble, TrendingUp, Users, Wallet } from "lucide-react";

const bars = [42, 55, 48, 62, 70, 66, 78, 84, 76, 88, 95, 90];

const roomCells: { label: string; state: "occ" | "vac" | "dirty" | "ooo" }[] = [
  { label: "101", state: "occ" }, { label: "102", state: "vac" },
  { label: "103", state: "occ" }, { label: "104", state: "dirty" },
  { label: "105", state: "occ" }, { label: "106", state: "vac" },
  { label: "201", state: "occ" }, { label: "202", state: "occ" },
  { label: "203", state: "ooo" }, { label: "204", state: "vac" },
  { label: "205", state: "occ" }, { label: "206", state: "dirty" },
];

const cellStyles = {
  occ: "bg-brand-700 text-white",
  vac: "bg-brand-100 text-brand-800",
  dirty: "bg-gold-200 text-gold-600",
  ooo: "bg-ink/10 text-ink/40 line-through",
};

export function DashboardPreview() {
  return (
    <div className="relative mx-auto max-w-5xl">
      <div className="absolute inset-x-8 -bottom-6 h-24 rounded-[2rem] bg-brand-900/10 blur-2xl" />
      <div className="relative overflow-hidden rounded-[1.5rem] border border-ink/8 bg-white shadow-2xl shadow-brand-900/10">
        {/* window chrome */}
        <div className="flex items-center gap-2 border-b border-ink/5 bg-cream px-6 py-4">
          <span className="h-3 w-3 rounded-full bg-ink/10" />
          <span className="h-3 w-3 rounded-full bg-ink/10" />
          <span className="h-3 w-3 rounded-full bg-ink/10" />
          <span className="ml-4 hidden rounded-md bg-white px-3 py-1 text-xs text-ink/40 sm:block">
            app.lodgiva.com — Grand Palm Hotel, Lagos
          </span>
        </div>

        <div className="grid gap-6 p-6 sm:p-8 lg:grid-cols-3">
          {/* KPI column */}
          <div className="space-y-4">
            {[
              { icon: BedDouble, label: "Occupancy tonight", value: "82%", sub: "41 of 50 rooms" },
              { icon: Wallet, label: "Revenue today", value: "₦1,906,500", sub: "+18% vs last week" },
              { icon: TrendingUp, label: "RevPAR", value: "₦38,130", sub: "ADR ₦46,500" },
              { icon: Users, label: "Arrivals today", value: "9", sub: "6 departures" },
            ].map((k) => (
              <div
                key={k.label}
                className="flex items-center gap-4 rounded-2xl border border-ink/5 bg-cream/60 p-4"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-800 text-white">
                  <k.icon className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-xs text-ink/50">{k.label}</p>
                  <p className="font-display text-xl font-semibold text-ink">
                    {k.value}
                  </p>
                  <p className="text-[11px] text-brand-600">{k.sub}</p>
                </div>
              </div>
            ))}
          </div>

          {/* chart */}
          <div className="rounded-2xl border border-ink/5 p-5">
            <p className="text-sm font-semibold text-ink">Occupancy — last 12 days</p>
            <div className="mt-6 flex h-44 items-end gap-2">
              {bars.map((b, i) => (
                <div
                  key={i}
                  className={`flex-1 rounded-t-md ${
                    i === bars.length - 2 ? "bg-gold-400" : "bg-brand-700/85"
                  }`}
                  style={{ height: `${b}%` }}
                />
              ))}
            </div>
            <div className="mt-4 flex justify-between text-[10px] text-ink/40">
              <span>Jul 17</span>
              <span>Jul 28</span>
            </div>
          </div>

          {/* room rack */}
          <div className="rounded-2xl border border-ink/5 p-5">
            <p className="text-sm font-semibold text-ink">Room rack</p>
            <div className="mt-5 grid grid-cols-4 gap-2">
              {roomCells.map((c) => (
                <div
                  key={c.label}
                  className={`rounded-lg py-3 text-center text-xs font-semibold ${cellStyles[c.state]}`}
                >
                  {c.label}
                </div>
              ))}
            </div>
            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-ink/50">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-brand-700" /> Occupied
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-brand-200" /> Vacant clean
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-gold-300" /> Needs cleaning
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
