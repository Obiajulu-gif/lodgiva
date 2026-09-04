"use client";

import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
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
interface ExportJob {
  id: string;
  type: string;
  format: string;
  status: string;
  rowCount: number | null;
  createdAt: string;
  completedAt: string | null;
}
interface ExportDetail extends ExportJob {
  error: string | null;
  download: { url: string; expiresAt: string } | null;
}

const OPERATIONAL_EXPORTS = ["DAILY_FLASH", "OCCUPANCY"];
const FINANCIAL_EXPORTS = [
  "REVENUE",
  "CASHIER",
  "TAX",
  "RECEIVABLES",
  "GUEST_LEDGER",
];

export default function ReportsPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const property =
    me?.properties.find((item) => item.id === selectedPropertyId) ??
    me?.properties[0];
  const propertyId = property?.id ?? "";
  const businessDate =
    property?.businessDate ?? new Date().toISOString().slice(0, 10);
  const date = new Date(`${businessDate}T00:00:00Z`);
  date.setUTCDate(1);
  const monthStart = date.toISOString().slice(0, 10);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(businessDate);
  const canOperational =
    me?.permissions.includes("report.operational.read") ?? false;
  const canFinancial =
    me?.permissions.includes("report.financial.read") ?? false;
  const canAudit = me?.permissions.includes("audit.read") ?? false;
  const exportTypes = [
    ...(canOperational ? OPERATIONAL_EXPORTS : []),
    ...(canFinancial ? FINANCIAL_EXPORTS : []),
    ...(canAudit ? ["AUDIT"] : []),
  ];
  const [exportType, setExportType] = useState(exportTypes[0] ?? "");
  const selectedExportType = exportTypes.includes(exportType)
    ? exportType
    : (exportTypes[0] ?? "");
  const [exportFormat, setExportFormat] = useState("CSV");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [flash, revenue, audit] = useQueries({
    queries: [
      {
        queryKey: ["report-flash", propertyId],
        queryFn: () =>
          api<Flash>(
            `/reports/daily-flash?propertyId=${encodeURIComponent(propertyId)}`,
          ),
        enabled: Boolean(propertyId) && canOperational,
      },
      {
        queryKey: ["report-revenue", propertyId, from, to],
        queryFn: () =>
          api<Revenue>(
            `/analytics/revenue?propertyId=${encodeURIComponent(propertyId)}&from=${from}&to=${to}`,
          ),
        enabled: Boolean(propertyId) && canFinancial,
      },
      {
        queryKey: ["report-audit", propertyId],
        queryFn: () =>
          api<Audit[]>(
            `/reports/audit-trail?propertyId=${encodeURIComponent(propertyId)}`,
          ),
        enabled: Boolean(propertyId) && canAudit,
      },
    ],
  });
  const jobs = useQuery({
    queryKey: ["report-exports", propertyId],
    queryFn: () =>
      api<ExportJob[]>(
        `/analytics/exports?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId) && exportTypes.length > 0,
    refetchInterval: (query) =>
      query.state.data?.some((job) =>
        ["QUEUED", "RUNNING"].includes(job.status),
      )
        ? 2_000
        : false,
  });
  const createExport = useMutation({
    mutationFn: () =>
      api<{ jobId: string }>("/analytics/exports", {
        method: "POST",
        body: {
          propertyId,
          type: selectedExportType,
          format: exportFormat,
          from,
          to,
        },
      }),
    onSuccess: async () => {
      setError("");
      setNotice("Export queued. It will appear below when the file is ready.");
      await queryClient.invalidateQueries({
        queryKey: ["report-exports", propertyId],
      });
    },
    onError: (cause) => {
      setNotice("");
      setError(
        cause instanceof Error ? cause.message : "Export could not be queued.",
      );
    },
  });
  const downloadExport = useMutation({
    mutationFn: (id: string) => api<ExportDetail>(`/analytics/exports/${id}`),
    onSuccess: (job) => {
      if (!job.download) {
        setError(job.error ?? "This export is not ready yet.");
        return;
      }
      const link = document.createElement("a");
      link.href = job.download.url;
      link.rel = "noopener";
      link.click();
      setError("");
      setNotice("Download started.");
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Download could not start.",
      ),
  });
  const firstError = [flash.error, revenue.error, audit.error, jobs.error].find(
    Boolean,
  );
  return (
    <div className="space-y-7">
      <header>
        <h1 className="font-display text-3xl font-semibold">Reports</h1>
        <p className="mt-1 text-sm text-ink/55">
          Auditable operating and revenue data for {from} through {to}.
        </p>
      </header>
      {error || firstError ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error || (firstError as Error).message} — dismiss
        </button>
      ) : null}
      {notice ? (
        <button
          type="button"
          onClick={() => setNotice("")}
          className="w-full rounded-xl bg-brand-50 p-3 text-left text-sm text-brand-700"
        >
          {notice} — dismiss
        </button>
      ) : null}
      <section className="rounded-2xl bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-ink/55">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
              className="mt-2 block rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
            />
          </label>
          <label className="text-xs font-semibold text-ink/55">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={businessDate}
              onChange={(event) => setTo(event.target.value)}
              className="mt-2 block rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
            />
          </label>
          {exportTypes.length ? (
            <>
              <label className="text-xs font-semibold text-ink/55">
                Report
                <select
                  value={selectedExportType}
                  onChange={(event) => setExportType(event.target.value)}
                  className="mt-2 block rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
                >
                  {exportTypes.map((type) => (
                    <option key={type} value={type}>
                      {type.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-ink/55">
                Format
                <select
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value)}
                  className="mt-2 block rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
                >
                  <option value="CSV">CSV</option>
                  <option value="PDF">PDF</option>
                </select>
              </label>
              <button
                type="button"
                disabled={
                  createExport.isPending ||
                  !selectedExportType ||
                  !from ||
                  !to ||
                  from > to
                }
                onClick={() => createExport.mutate()}
                className="rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
              >
                {createExport.isPending ? "Queuing…" : "Create export"}
              </button>
            </>
          ) : (
            <p className="text-sm text-ink/45">
              Your role does not include report export access.
            </p>
          )}
        </div>
      </section>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Occupancy today", flash.data ? `${flash.data.occupancyPct}%` : "—"],
          [
            "Revenue today",
            flash.data ? naira(flash.data.revenueTodayMinor) : "—",
          ],
          ["Period net", revenue.data ? naira(revenue.data.netMinor) : "—"],
          [
            "Outstanding",
            flash.data ? naira(flash.data.outstandingMinor) : "—",
          ],
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
      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="px-6 py-5">
          <h2 className="font-semibold">Generated exports</h2>
          <p className="mt-1 text-xs text-ink/45">
            Files are generated server-side and stored durably with expiring
            download links.
          </p>
        </div>
        <div className="divide-y divide-ink/5">
          {(jobs.data ?? []).map((job) => (
            <div
              key={job.id}
              className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 text-sm"
            >
              <div>
                <strong>
                  {job.type.replaceAll("_", " ")} · {job.format}
                </strong>
                <p className="text-xs text-ink/45">
                  {new Date(job.createdAt).toLocaleString("en-NG")}
                  {job.rowCount !== null ? ` · ${job.rowCount} rows` : ""}
                </p>
              </div>
              {job.status === "COMPLETE" ? (
                <button
                  type="button"
                  disabled={downloadExport.isPending}
                  onClick={() => downloadExport.mutate(job.id)}
                  className="rounded-full bg-brand-800 px-4 py-2 text-xs font-semibold text-white disabled:opacity-40"
                >
                  Download
                </button>
              ) : (
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${job.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-cream text-ink/55"}`}
                >
                  {job.status}
                </span>
              )}
            </div>
          ))}
        </div>
        {!jobs.isPending && !jobs.data?.length ? (
          <p className="p-8 text-center text-sm text-ink/45">
            No exports have been generated for this property.
          </p>
        ) : null}
      </section>
    </div>
  );
}
