"use client";

import Link from "next/link";
import { useQueries } from "@tanstack/react-query";
import {
  ArrowRight,
  BedDouble,
  CalendarDays,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { naira, type MoneyMinor } from "@/lib/api/money";

interface DailyFlash {
  businessDate: string;
  totalRooms: number;
  occupied: number;
  occupancyPct: number;
  arrivalsToday: number;
  departuresToday: number;
  revenueTodayMinor: MoneyMinor;
  outstandingMinor: MoneyMinor;
  paymentsByMethod: { method: string; count: number; totalMinor: MoneyMinor }[];
}

interface OccupancyReport {
  from: string;
  to: string;
  days: {
    date: string;
    available: number;
    sold: number;
    occupancyPct: number;
    roomRevenueMinor: MoneyMinor;
  }[];
  totals: {
    roomNightsSold: number;
    roomNightsAvailable: number;
    occupancyPct: number;
    adrMinor: MoneyMinor;
    revparMinor: MoneyMinor;
  };
}

interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  guest: { firstName: string; lastName: string; vip: boolean };
  rooms: { room: { roomNumber: string } | null }[];
}

interface AuditEvent {
  id: string;
  action: string;
  entityType: string;
  createdAt: string;
}

const statusStyles: Record<string, string> = {
  CHECKED_IN: "bg-brand-100 text-brand-800",
  CONFIRMED: "bg-blue-50 text-blue-700",
  PENDING_PAYMENT: "bg-gold-100 text-gold-600",
  HOLD: "bg-purple-50 text-purple-700",
  CHECKED_OUT: "bg-ink/5 text-ink/50",
  CANCELLED: "bg-red-50 text-red-600",
  NO_SHOW: "bg-red-50 text-red-600",
};

function isoOffset(iso: string, offset: number) {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return date.toISOString().slice(0, 10);
}

function shortDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default function DashboardOverview() {
  const { me, selectedPropertyId } = useAuth();
  const property =
    me?.properties.find((candidate) => candidate.id === selectedPropertyId) ??
    me?.properties[0];
  const propertyId = property?.id ?? "";
  const canOperational =
    me?.permissions.includes("report.operational.read") ?? false;
  const canAudit = me?.permissions.includes("audit.read") ?? false;
  const canReadReservations =
    me?.permissions.includes("reservation.read") ?? false;
  const businessDate =
    property?.businessDate ?? new Date().toISOString().slice(0, 10);
  const from = isoOffset(businessDate, -6);
  const query = (path: string) =>
    `${path}${path.includes("?") ? "&" : "?"}propertyId=${encodeURIComponent(propertyId)}`;
  const [flashQuery, occupancyQuery, reservationsQuery, auditQuery] =
    useQueries({
      queries: [
        {
          queryKey: ["daily-flash", propertyId],
          queryFn: () => api<DailyFlash>(query("/reports/daily-flash")),
          enabled: Boolean(propertyId) && canOperational,
          refetchInterval: 30_000,
        },
        {
          queryKey: ["occupancy", propertyId, from, businessDate],
          queryFn: () =>
            api<OccupancyReport>(
              query(`/analytics/occupancy?from=${from}&to=${businessDate}`),
            ),
          enabled: Boolean(propertyId) && canOperational,
          refetchInterval: 60_000,
        },
        {
          queryKey: ["reservations", propertyId],
          queryFn: () => api<Reservation[]>(query("/reservations")),
          enabled: Boolean(propertyId) && canReadReservations,
          refetchInterval: 30_000,
        },
        {
          queryKey: ["audit", propertyId],
          queryFn: () => api<AuditEvent[]>(query("/reports/audit-trail")),
          enabled: Boolean(propertyId) && canAudit,
          refetchInterval: 30_000,
        },
      ],
    });

  const flash = flashQuery.data;
  const occupancy = occupancyQuery.data;
  const activeReservations = (reservationsQuery.data ?? [])
    .filter((reservation) =>
      ["CHECKED_IN", "CONFIRMED", "PENDING_PAYMENT", "HOLD"].includes(
        reservation.status,
      ),
    )
    .slice(0, 8);
  const firstError = [
    canOperational ? flashQuery.error : null,
    canOperational ? occupancyQuery.error : null,
    canReadReservations ? reservationsQuery.error : null,
    canAudit ? auditQuery.error : null,
  ].find(Boolean);
  const loading =
    (canOperational && (flashQuery.isPending || occupancyQuery.isPending)) ||
    (canReadReservations && reservationsQuery.isPending) ||
    (canAudit && auditQuery.isPending);

  if (firstError && !flash && !occupancy) {
    return (
      <div className="rounded-2xl border border-red-100 bg-white p-8">
        <h1 className="font-display text-2xl font-semibold">
          We couldn&apos;t load today&apos;s operations
        </h1>
        <p className="mt-2 text-sm text-ink/55">
          {firstError instanceof Error
            ? firstError.message
            : "The API request failed."}
        </p>
        <button
          type="button"
          onClick={() =>
            void Promise.all([
              canOperational ? flashQuery.refetch() : Promise.resolve(),
              canOperational ? occupancyQuery.refetch() : Promise.resolve(),
              canReadReservations
                ? reservationsQuery.refetch()
                : Promise.resolve(),
              canAudit ? auditQuery.refetch() : Promise.resolve(),
            ])
          }
          className="mt-6 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            Welcome, {me?.user.fullName.split(" ")[0]}
          </h1>
          <p className="mt-1 text-ink/55">
            Live operations for {property?.name}.
          </p>
        </div>
        <span className="rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700">
          {loading ? "Updating…" : "Live API data"}
        </span>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          href="/dashboard/rooms"
          icon={BedDouble}
          label="Occupancy"
          value={`${flash?.occupancyPct ?? 0}%`}
          sub={`${flash?.occupied ?? 0} of ${flash?.totalRooms ?? 0} rooms in-house`}
        />
        <Kpi
          href="/dashboard/payments"
          icon={Wallet}
          label="Revenue today"
          value={naira(flash?.revenueTodayMinor ?? 0)}
          sub={`Outstanding ${naira(flash?.outstandingMinor ?? 0)}`}
        />
        <Kpi
          href="/dashboard/reports"
          icon={TrendingUp}
          label="ADR / RevPAR"
          value={naira(occupancy?.totals.adrMinor ?? 0)}
          sub={`RevPAR ${naira(occupancy?.totals.revparMinor ?? 0)}`}
        />
        <Kpi
          href="/dashboard/reservations"
          icon={Users}
          label="Movements today"
          value={`${flash?.arrivalsToday ?? 0} in · ${flash?.departuresToday ?? 0} out`}
          sub={`${activeReservations.length} active reservations shown`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <section
          className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm xl:col-span-2"
          aria-labelledby="occupancy-heading"
        >
          <div className="flex items-center justify-between">
            <h2 id="occupancy-heading" className="font-semibold text-ink">
              Occupancy — last seven business dates
            </h2>
            <span className="text-xs text-ink/45">
              {shortDate(from)} – {shortDate(businessDate)}
            </span>
          </div>
          {occupancy?.days.length ? (
            <div className="mt-8 flex h-56 items-end gap-3">
              {occupancy.days.map((day) => (
                <div
                  key={day.date}
                  className="flex min-w-0 flex-1 flex-col items-center gap-2"
                >
                  <span className="text-xs font-semibold text-ink/60">
                    {day.occupancyPct}%
                  </span>
                  <div
                    className="w-full rounded-t-lg bg-brand-700"
                    style={{
                      height: `${Math.max(4, day.occupancyPct * 1.8)}px`,
                    }}
                    title={`${day.sold} of ${day.available} rooms sold`}
                  />
                  <span className="text-[11px] text-ink/45">
                    {shortDate(day.date)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="No room inventory or occupancy activity is available for this period." />
          )}
        </section>

        <section
          className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm"
          aria-labelledby="payments-heading"
        >
          <h2 id="payments-heading" className="font-semibold text-ink">
            Confirmed payments
          </h2>
          {flash?.paymentsByMethod.length ? (
            <div className="mt-6 space-y-4">
              {flash.paymentsByMethod.map((payment) => (
                <div
                  key={payment.method}
                  className="border-b border-ink/5 pb-4 last:border-0"
                >
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="capitalize text-ink/65">
                      {payment.method.toLowerCase().replaceAll("_", " ")}
                    </span>
                    <strong>{naira(payment.totalMinor)}</strong>
                  </div>
                  <p className="mt-1 text-xs text-ink/40">
                    {payment.count} transaction{payment.count === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState text="No confirmed payments have been recorded yet." />
          )}
        </section>
      </div>

      <section
        className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm"
        aria-labelledby="reservations-heading"
      >
        <div className="flex items-center justify-between px-6 py-5">
          <div>
            <h2 id="reservations-heading" className="font-semibold text-ink">
              Active reservations
            </h2>
            <p className="mt-0.5 text-xs text-ink/45">
              Most recent operational stays
            </p>
          </div>
          <Link
            href="/dashboard/reservations"
            className="flex items-center gap-1 text-sm font-semibold text-brand-700 hover:text-brand-600"
          >
            View all <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        {activeReservations.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-t border-ink/5 bg-cream/60 text-xs text-ink/50">
                  <th className="px-6 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Guest</th>
                  <th className="px-4 py-3 font-medium">Room</th>
                  <th className="px-4 py-3 font-medium">Stay</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {activeReservations.map((reservation) => (
                  <tr key={reservation.id} className="border-t border-ink/5">
                    <td className="px-6 py-4 font-mono text-xs text-brand-700">
                      {reservation.confirmationCode}
                    </td>
                    <td className="px-4 py-4 font-medium">
                      {reservation.guest.firstName} {reservation.guest.lastName}
                      {reservation.guest.vip ? (
                        <span className="ml-2 rounded bg-gold-100 px-1.5 py-0.5 text-[10px] font-bold text-gold-600">
                          VIP
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-4 text-ink/60">
                      {reservation.rooms
                        .map((room) => room.room?.roomNumber)
                        .filter(Boolean)
                        .join(", ") || "Unassigned"}
                    </td>
                    <td className="px-4 py-4 text-ink/60">
                      {shortDate(reservation.arrivalDate)} →{" "}
                      {shortDate(reservation.departureDate)}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${statusStyles[reservation.status] ?? "bg-ink/5 text-ink/60"}`}
                      >
                        {reservation.status.replaceAll("_", " ")}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-ink/5">
            <EmptyState text="No active reservations. New reservations will appear here." />
          </div>
        )}
      </section>

      <section
        className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm"
        aria-labelledby="activity-heading"
      >
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-brand-700" />
          <h2 id="activity-heading" className="font-semibold text-ink">
            Recent activity
          </h2>
        </div>
        {auditQuery.data?.length ? (
          <ul className="mt-5 divide-y divide-ink/5">
            {auditQuery.data.slice(0, 6).map((event) => (
              <li
                key={event.id}
                className="flex items-center justify-between gap-4 py-3 text-sm"
              >
                <span>
                  <strong className="font-semibold">
                    {event.action.replaceAll("_", " ")}
                  </strong>
                  <span className="ml-2 text-ink/45">{event.entityType}</span>
                </span>
                <time
                  dateTime={event.createdAt}
                  className="shrink-0 text-xs text-ink/40"
                >
                  {new Date(event.createdAt).toLocaleString("en-NG")}
                </time>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState text="No audited activity has been recorded for this property yet." />
        )}
      </section>
    </div>
  );
}

function Kpi({
  href,
  icon: Icon,
  label,
  value,
  sub,
}: {
  href: string;
  icon: typeof BedDouble;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-ink/5 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <Icon className="h-5 w-5" />
        </span>
        <ArrowRight className="h-4 w-4 text-ink/25 transition group-hover:translate-x-0.5 group-hover:text-brand-700" />
      </div>
      <p className="mt-5 text-sm text-ink/50">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink">
        {value}
      </p>
      <p className="mt-1 text-xs text-ink/45">{sub}</p>
    </Link>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="my-8 rounded-xl bg-cream px-4 py-6 text-center text-sm text-ink/45">
      {text}
    </p>
  );
}
