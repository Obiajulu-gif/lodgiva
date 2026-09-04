"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { minorBigInt, naira, type MoneyMinor } from "@/lib/api/money";

interface Payment {
  id: string;
  method: string;
  provider: string | null;
  amountMinor: MoneyMinor;
  status: string;
  externalReference: string | null;
  receivedAt: string;
  folio: {
    guest: { firstName: string; lastName: string };
    reservation: { confirmationCode: string } | null;
  };
}

export default function PaymentsPage() {
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const payments = useQuery({
    queryKey: ["payments", propertyId],
    queryFn: () =>
      api<Payment[]>(`/payments?propertyId=${encodeURIComponent(propertyId)}`),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const confirmed = (payments.data ?? [])
    .filter((payment) => payment.status === "CONFIRMED")
    .reduce((sum, payment) => sum + minorBigInt(payment.amountMinor), 0n);
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Payments</h1>
          <p className="mt-1 text-sm text-ink/55">
            Provider-backed payment records posted to guest folios.
          </p>
        </div>
        <span className="rounded-full bg-brand-50 px-4 py-2 text-xs font-semibold text-brand-700">
          Confirmed {naira(confirmed)}
        </span>
      </header>
      <section className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3 font-medium">Guest / reservation</th>
                <th className="px-4 py-3 font-medium">Method</th>
                <th className="px-4 py-3 font-medium">Provider</th>
                <th className="px-4 py-3 font-medium">Reference</th>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-6 py-3 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(payments.data ?? []).map((payment) => (
                <tr key={payment.id} className="border-t border-ink/5">
                  <td className="px-6 py-4 font-medium">
                    {payment.folio.guest.firstName}{" "}
                    {payment.folio.guest.lastName}
                    <span className="ml-2 text-xs font-normal text-ink/40">
                      {payment.folio.reservation?.confirmationCode}
                    </span>
                  </td>
                  <td className="px-4 py-4 capitalize text-ink/60">
                    {payment.method.toLowerCase().replaceAll("_", " ")}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {payment.provider ?? "—"}
                  </td>
                  <td className="px-4 py-4 font-mono text-xs text-ink/50">
                    {payment.externalReference ?? "—"}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {new Date(payment.receivedAt).toLocaleString("en-NG")}
                  </td>
                  <td className="px-4 py-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${payment.status === "CONFIRMED" ? "bg-brand-50 text-brand-700" : payment.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-gold-100 text-gold-600"}`}
                    >
                      {payment.status}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right font-semibold">
                    {naira(payment.amountMinor)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!payments.isPending && !payments.data?.length ? (
          <p className="border-t border-ink/5 p-10 text-center text-sm text-ink/45">
            No payments yet. Payments taken from reservation folios will appear
            here.
          </p>
        ) : null}
      </section>
      {payments.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {payments.error.message}
        </p>
      ) : null}
    </div>
  );
}
