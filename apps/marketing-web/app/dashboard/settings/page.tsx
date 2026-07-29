import { Building2, Percent, Users2, ShieldCheck } from "lucide-react";

const taxes = [
  { code: "VAT", name: "Value Added Tax", rate: "7.5%", applies: "All charges", basis: "Exclusive" },
  { code: "LSCT", name: "Lagos Consumption Tax", rate: "5%", applies: "Rooms, F&B", basis: "Exclusive" },
  { code: "SVC", name: "Service Charge", rate: "5%", applies: "Rooms, F&B", basis: "Before tax" },
];

const staff = [
  { name: "Adanna Okeke", role: "General Manager", scope: "All modules", mfa: true },
  { name: "Bola Adesina", role: "Front Desk", scope: "Reservations, Check-in, Payments", mfa: false },
  { name: "Chidi Nwachukwu", role: "Cashier", scope: "POS, Shift close", mfa: false },
  { name: "Mary Johnson", role: "Housekeeping", scope: "Room board, Tasks", mfa: false },
  { name: "Ngozi Eze", role: "Finance", scope: "Reconciliation, Refunds, Reports", mfa: true },
];

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Property Settings
        </h1>
        <p className="mt-1 text-ink/55">
          Configuration for Grand Palm Hotel — taxes, policies and staff access.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* property profile */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Building2 className="h-4 w-4 text-brand-700" />
            Property profile
          </h2>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 text-sm">
            {[
              ["Property name", "Grand Palm Hotel"],
              ["Property code", "GPH-LAG"],
              ["Timezone", "Africa/Lagos"],
              ["Currency", "NGN (₦)"],
              ["Check-in time", "2:00 PM"],
              ["Check-out time", "12:00 PM"],
              ["Rooms", "50"],
              ["Business date", "28 Jul 2026"],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink/45">{k}</dt>
                <dd className="mt-1 font-medium text-ink">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-6 rounded-xl bg-cream px-4 py-3 text-xs leading-relaxed text-ink/55">
            The business date advances only through night audit — never by the
            wall clock. All timestamps are stored in UTC.
          </p>
        </div>

        {/* taxes */}
        <div className="rounded-2xl border border-ink/5 bg-white p-7 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Percent className="h-4 w-4 text-brand-700" />
            Taxes & service charge
          </h2>
          <table className="mt-6 w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-ink/45">
                <th className="pb-3 font-medium">Code</th>
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">Rate</th>
                <th className="pb-3 font-medium">Applies to</th>
              </tr>
            </thead>
            <tbody>
              {taxes.map((t) => (
                <tr key={t.code} className="border-t border-ink/5">
                  <td className="py-3.5 font-mono text-xs text-brand-700">
                    {t.code}
                  </td>
                  <td className="py-3.5 text-ink/75">{t.name}</td>
                  <td className="py-3.5 font-semibold text-ink">{t.rate}</td>
                  <td className="py-3.5 text-ink/55">{t.applies}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-5 rounded-xl bg-cream px-4 py-3 text-xs leading-relaxed text-ink/55">
            Tax rules are versioned with effective dates. Changing a rate never
            rewrites historical invoices — posted lines keep the rule version
            they were billed under.
          </p>
        </div>
      </div>

      {/* staff */}
      <div className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="flex items-center justify-between px-7 py-5">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Users2 className="h-4 w-4 text-brand-700" />
            Staff & roles
          </h2>
          <button className="rounded-full bg-brand-800 px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-700">
            Invite staff
          </button>
        </div>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-cream/60 text-xs text-ink/50">
              <th className="px-7 py-3.5 font-medium">Name</th>
              <th className="px-4 py-3.5 font-medium">Role</th>
              <th className="px-4 py-3.5 font-medium">Access scope</th>
              <th className="px-7 py-3.5 font-medium">MFA</th>
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.name} className="border-t border-ink/5">
                <td className="px-7 py-4 font-medium text-ink">{s.name}</td>
                <td className="px-4 py-4">
                  <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                    {s.role}
                  </span>
                </td>
                <td className="px-4 py-4 text-ink/60">{s.scope}</td>
                <td className="px-7 py-4">
                  {s.mfa ? (
                    <span className="flex w-fit items-center gap-1 rounded-full bg-brand-100 px-2.5 py-1 text-[11px] font-semibold text-brand-800">
                      <ShieldCheck className="h-3 w-3" /> Enabled
                    </span>
                  ) : (
                    <span className="text-xs text-ink/40">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
