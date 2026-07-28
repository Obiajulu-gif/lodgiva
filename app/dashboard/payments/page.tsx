import { Wallet, CheckCircle2, Clock4, RotateCcw } from "lucide-react";
import { payments, formatNaira } from "@/lib/data";

const statusStyles: Record<string, string> = {
  Confirmed: "bg-brand-100 text-brand-800",
  Pending: "bg-gold-100 text-gold-600",
  Refunded: "bg-blue-50 text-blue-600",
  Failed: "bg-red-50 text-red-600",
};

export default function PaymentsPage() {
  const confirmed = payments
    .filter((p) => p.status === "Confirmed")
    .reduce((s, p) => s + p.amount, 0);
  const pending = payments
    .filter((p) => p.status === "Pending")
    .reduce((s, p) => s + p.amount, 0);
  const refunded = payments
    .filter((p) => p.status === "Refunded")
    .reduce((s, p) => s + p.amount, 0);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Payments & Reconciliation
        </h1>
        <p className="mt-1 text-ink/55">
          Every payment is verified server-side and matched to a folio —
          nothing confirms without a signed gateway webhook.
        </p>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        {[
          { icon: CheckCircle2, label: "Confirmed today", value: formatNaira(confirmed), cls: "text-brand-700 bg-brand-50" },
          { icon: Clock4, label: "Awaiting verification", value: formatNaira(pending), cls: "text-gold-600 bg-gold-100" },
          { icon: RotateCcw, label: "Refunded (approved)", value: formatNaira(refunded), cls: "text-blue-600 bg-blue-50" },
        ].map((k) => (
          <div
            key={k.label}
            className="flex items-center gap-4 rounded-2xl border border-ink/5 bg-white p-6 shadow-sm"
          >
            <span
              className={`flex h-11 w-11 items-center justify-center rounded-xl ${k.cls}`}
            >
              <k.icon className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm text-ink/50">{k.label}</p>
              <p className="font-display text-xl font-semibold text-ink">
                {k.value}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="flex items-center justify-between px-6 py-5">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Wallet className="h-4.5 w-4.5 text-brand-700" />
            Recent transactions
          </h2>
          <span className="text-xs text-ink/45">Cashier shift #S-0412 · open</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/60 text-xs text-ink/50">
                <th className="px-6 py-3.5 font-medium">Reference</th>
                <th className="px-4 py-3.5 font-medium">Guest / Folio</th>
                <th className="px-4 py-3.5 font-medium">Method</th>
                <th className="px-4 py-3.5 font-medium">Provider</th>
                <th className="px-4 py-3.5 font-medium">Date</th>
                <th className="px-4 py-3.5 font-medium">Status</th>
                <th className="px-6 py-3.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr
                  key={p.id}
                  className="border-t border-ink/5 transition-colors hover:bg-cream/40"
                >
                  <td className="px-6 py-4 font-mono text-xs text-brand-700">
                    {p.reference}
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-medium text-ink">{p.guest}</p>
                    <p className="text-xs text-ink/45">{p.folio}</p>
                  </td>
                  <td className="px-4 py-4 text-ink/60">{p.method}</td>
                  <td className="px-4 py-4 text-ink/60">{p.provider}</td>
                  <td className="px-4 py-4 text-ink/60">{p.date}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusStyles[p.status]}`}
                    >
                      {p.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right font-semibold text-ink">
                    {formatNaira(p.amount)}
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
