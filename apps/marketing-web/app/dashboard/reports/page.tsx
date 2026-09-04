"use client";

import { useQueries } from "@tanstack/react-query";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { naira, type MoneyMinor } from "@/lib/api/money";

interface Revenue {
  grossMinor: MoneyMinor;
  discountMinor: MoneyMinor;
  taxMinor: MoneyMinor;
  netMinor: MoneyMinor;
  totalBilledMinor: MoneyMinor;
  byCategory: { category: string; amountMinor: MoneyMinor }[];
}
interface Flash {
  businessDate: string;
  occupancyPct: number;
  arrivalsToday: number;
  departuresToday: number;
  revenueTodayMinor: MoneyMinor;
  outstandingMinor: MoneyMinor;
}
interface Audit {
  id: string;
  action: string;
  entityType: string;
  createdAt: string;
  userId: string | null;
}

export default function ReportsPage() {
  const { me, selectedPropertyId } = useAuth();
  const property =
    me?.properties.find((item) => item.id === selectedPropertyId) ??
    me?.properties[0];
  const propertyId = property?.id ?? "";
  const to = property?.businessDate ?? new Date().toISOString().slice(0, 10);
  const date = new Date(`${to}T00:00:00Z`);
  date.setUTCDate(1);
  const from = date.toISOString().slice(0, 10);
  const [flash, revenue, audit] = useQueries({
    queries: [
      {
        queryKey: ["report-flash", propertyId],
        queryFn: () =>
          api<Flash>(
            `/reports/daily-flash?propertyId=${encodeURIComponent(propertyId)}`,
          ),
        enabled: Boolean(propertyId),
      },
      {
        queryKey: ["report-revenue", propertyId, from, to],
        queryFn: () =>
          api<Revenue>(
            `/analytics/revenue?propertyId=${encodeURIComponent(propertyId)}&from=${from}&to=${to}`,
          ),
        enabled: Boolean(propertyId),
      },
      {
        queryKey: ["report-audit", propertyId],
        queryFn: () =>
          api<Audit[]>(
            `/reports/audit-trail?propertyId=${encodeURIComponent(propertyId)}`,
          ),
        enabled: Boolean(propertyId),
      },
    ],
  });
  return (
    <div className="space-y-7">
      <header>
        <h1 className="font-display text-3xl font-semibold">Reports</h1>
        <p className="mt-1 text-sm text-ink/55">
          Auditable operating and revenue data for {from} through {to}.
        </p>
      </header>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Occupancy today", `${flash.data?.occupancyPct ?? 0}%`],
          ["Revenue today", naira(flash.data?.revenueTodayMinor ?? 0)],
          ["Month-to-date net", naira(revenue.data?.netMinor ?? 0)],
          ["Outstanding", naira(flash.data?.outstandingMinor ?? 0)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-white p-6 shadow-sm">
            <p className="text-sm text-ink/50">{label}</p>
            <p className="mt-2 font-display text-2xl font-semibold">{value}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="font-semibold">Revenue by category</h2>
          <div className="mt-5 divide-y divide-ink/5">
            {(revenue.data?.byCategory ?? []).map((item) => (
              <div
                key={item.category}
                className="flex justify-between py-3 text-sm"
              >
                <span>{item.category.replaceAll("_", " ")}</span>
                <strong>{naira(item.amountMinor)}</strong>
              </div>
            ))}
          </div>
          {!revenue.isPending && !revenue.data?.byCategory.length ? (
            <p className="mt-6 text-sm text-ink/45">
              No billed revenue in this period.
            </p>
          ) : null}
        </section>
        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="font-semibold">Revenue reconciliation</h2>
          <dl className="mt-5 space-y-3 text-sm">
            {[
              ["Gross", revenue.data?.grossMinor],
              ["Discounts", revenue.data?.discountMinor],
              ["Taxes & service", revenue.data?.taxMinor],
              ["Total billed", revenue.data?.totalBilledMinor],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="flex justify-between border-b border-ink/5 pb-3"
              >
                <dt className="text-ink/55">{label}</dt>
                <dd className="font-semibold">
                  {naira((value ?? 0) as MoneyMinor)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="px-6 py-5">
          <h2 className="font-semibold">Append-only audit trail</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3">Action</th>
                <th className="px-4 py-3">Entity</th>
                <th className="px-6 py-3">When</th>
              </tr>
            </thead>
            <tbody>
              {(audit.data ?? []).slice(0, 30).map((event) => (
                <tr key={event.id} className="border-t border-ink/5">
                  <td className="px-6 py-4 font-medium">
                    {event.action.replaceAll("_", " ")}
                  </td>
                  <td className="px-4 py-4 text-ink/55">{event.entityType}</td>
                  <td className="px-6 py-4 text-ink/55">
                    {new Date(event.createdAt).toLocaleString("en-NG")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!audit.isPending && !audit.data?.length ? (
          <p className="p-8 text-center text-sm text-ink/45">
            No audit events yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}
