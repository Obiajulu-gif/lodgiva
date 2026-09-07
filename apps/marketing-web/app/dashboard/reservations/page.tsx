"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import {
  CheckInDialog,
  CreateReservationDialog,
  FolioDialog,
  type Reservation,
} from "./reservation-workflows";

export default function ReservationsPage() {
  return <Suspense fallback={<p role="status">Loading reservations…</p>}><ReservationsContent /></Suspense>;
}

function ReservationsContent() {
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const property =
    me?.properties.find((candidate) => candidate.id === selectedPropertyId) ??
    me?.properties[0];
  const propertyId = property?.id ?? "";
  const canCreate = me?.permissions.includes("reservation.create") ?? false;
  const canCancel = me?.permissions.includes("reservation.cancel") ?? false;
  const canCheckIn = me?.permissions.includes("frontdesk.check_in") ?? false;
  const canCheckOut = me?.permissions.includes("frontdesk.check_out") ?? false;
  const canReadFolio = me?.permissions.includes("folio.read") ?? false;
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("ACTIVE");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [checkInFor, setCheckInFor] = useState<Reservation | null>(null);
  const [folioFor, setFolioFor] = useState<Reservation | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reservations = useQuery({
    queryKey: ["reservations", propertyId, search, status, from, to, page],
    queryFn: () =>
      api<Reservation[]>(
        `/reservations?${new URLSearchParams({ propertyId, q: search, status, from, to, offset: String(page * 50), limit: "51" })}`,
      ),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });

  async function refresh(message?: string) {
    if (message) setNotice(message);
    setError("");
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["reservations", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["room-rack", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["daily-flash", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["payments", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["housekeeping", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["reservation-availability", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["guests"] }),
    ]);
  }
  const lifecycle = useMutation({
    mutationFn: ({
      id,
      operation,
      body,
    }: {
      id: string;
      operation: "cancel" | "check-out" | "no-show";
      body: unknown;
    }) => api(`/reservations/${id}/${operation}`, { method: "POST", body }),
    onSuccess: async (_, variables) =>
      refresh(
        `Reservation ${variables.operation.replace("-", " ")} completed.`,
      ),
    onError: (cause) => {
      setNotice("");
      setError(
        cause instanceof Error
          ? cause.message
          : "The reservation could not be updated.",
      );
    },
  });
  const filtered = (reservations.data ?? []).slice(0, 50);

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Reservations</h1>
          <p className="mt-1 text-sm text-ink/55">
            Create, find, arrive, settle, and complete real guest stays.
          </p>
        </div>
        {canCreate ? (
          <button
            type="button"
            onClick={() => {
              setCreateOpen(true);
              setError("");
            }}
            className="flex items-center gap-2 rounded-full bg-brand-800 px-4 py-2.5 text-sm font-semibold text-white"
          >
            <Plus className="h-4 w-4" /> New reservation
          </button>
        ) : null}
      </header>
      {error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
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
      <section className="grid gap-3 rounded-2xl bg-white p-4 shadow-sm md:grid-cols-[minmax(220px,1fr)_180px_160px_160px]">
        <label className="relative">
          <span className="sr-only">Search reservations</span>
          <Search className="absolute left-3 top-3 h-4 w-4 text-ink/35" />
          <input
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(0); }}
            placeholder="Code, guest, or room"
            className="w-full rounded-xl border border-ink/10 py-2.5 pl-10 pr-3 text-sm outline-none focus:border-brand-500"
          />
        </label>
        <label>
          <span className="sr-only">Status</span>
          <select
            value={status}
            onChange={(event) => { setStatus(event.target.value); setPage(0); }}
            className="w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
          >
            <option value="ACTIVE">Active stays</option>
            <option value="ALL">All statuses</option>
            <option value="CONFIRMED">Confirmed</option>
            <option value="CHECKED_IN">Checked in</option>
            <option value="CHECKED_OUT">Checked out</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="NO_SHOW">No show</option>
          </select>
        </label>
        <label className="text-[11px] font-semibold text-ink/45">
          FROM
          <input
            type="date"
            value={from}
            onChange={(event) => { setFrom(event.target.value); setPage(0); }}
            className="mt-1 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm font-normal text-ink"
          />
        </label>
        <label className="text-[11px] font-semibold text-ink/45">
          TO
          <input
            type="date"
            value={to}
            onChange={(event) => { setTo(event.target.value); setPage(0); }}
            className="mt-1 w-full rounded-xl border border-ink/10 px-3 py-2 text-sm font-normal text-ink"
          />
        </label>
      </section>
      <section className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Guest</th>
                <th className="px-4 py-3 font-medium">Room</th>
                <th className="px-4 py-3 font-medium">Stay</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-6 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((reservation) => (
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
                  <td className="whitespace-nowrap px-4 py-4 text-ink/60">
                    {reservation.arrivalDate} → {reservation.departureDate}
                  </td>
                  <td className="px-4 py-4">
                    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                      {reservation.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex justify-end gap-2">
                      {reservation.status === "CONFIRMED" && canCheckIn && reservation.arrivalDate <= (property?.businessDate ?? "") && reservation.departureDate > (property?.businessDate ?? "") ? (
                        <button
                          type="button"
                          onClick={() => setCheckInFor(reservation)}
                          className="rounded-lg bg-brand-800 px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          Check in
                        </button>
                      ) : null}
                      {reservation.status === "CHECKED_IN" && canReadFolio ? (
                        <button
                          type="button"
                          onClick={() => setFolioFor(reservation)}
                          className="rounded-lg border border-brand-200 px-3 py-1.5 text-xs font-semibold text-brand-700"
                        >
                          Folio
                        </button>
                      ) : null}
                      {reservation.status === "CHECKED_IN" && canCheckOut ? (
                        <button
                          type="button"
                          disabled={lifecycle.isPending}
                          onClick={() =>
                            lifecycle.mutate({
                              id: reservation.id,
                              operation: "check-out",
                              body: {},
                            })
                          }
                          className="rounded-lg bg-brand-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Check out
                        </button>
                      ) : null}
                      {reservation.status === "CONFIRMED" &&
                      canCancel &&
                      reservation.arrivalDate <=
                        (property?.businessDate ?? "") ? (
                        <button
                          type="button"
                          disabled={lifecycle.isPending}
                          onClick={() =>
                            window.confirm(
                              `Mark ${reservation.confirmationCode} as a no-show?`,
                            ) &&
                            lifecycle.mutate({
                              id: reservation.id,
                              operation: "no-show",
                              body: {},
                            })
                          }
                          className="rounded-lg border border-gold-300 px-3 py-1.5 text-xs font-semibold text-gold-600"
                        >
                          No show
                        </button>
                      ) : null}
                      {["CONFIRMED", "HOLD", "PENDING_PAYMENT"].includes(
                        reservation.status,
                      ) && canCancel ? (
                        <button
                          type="button"
                          disabled={lifecycle.isPending}
                          onClick={() => {
                            const reason = window.prompt(
                              `Reason for cancelling ${reservation.confirmationCode}:`,
                            );
                            if (reason?.trim())
                              lifecycle.mutate({
                                id: reservation.id,
                                operation: "cancel",
                                body: { reason: reason.trim() },
                              });
                          }}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700"
                        >
                          Cancel
                        </button>
                      ) : null}
                      {["CHECKED_OUT", "CANCELLED", "NO_SHOW"].includes(
                        reservation.status,
                      ) &&
                      canReadFolio &&
                      reservation.folios.length ? (
                        <button
                          type="button"
                          onClick={() => setFolioFor(reservation)}
                          className="rounded-lg border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink/60"
                        >
                          Folio
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {reservations.isPending ? <p role="status" className="p-10 text-center">Loading reservations…</p> : null}
        {reservations.isSuccess && !filtered.length ? (
          <p className="p-10 text-center text-sm text-ink/45">
            {search || status !== "ALL" || from || to
              ? "No reservations match these filters."
              : "No reservations yet."}
          </p>
        ) : null}
      </section>
      <div className="flex items-center justify-between text-sm">
        <button type="button" disabled={page === 0 || reservations.isFetching} onClick={() => setPage((current) => current - 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Previous page</button>
        <span>Page {page + 1} · {filtered.length} reservations</span>
        <button type="button" disabled={(reservations.data?.length ?? 0) <= 50 || reservations.isFetching} onClick={() => setPage((current) => current + 1)} className="rounded-lg border px-3 py-2 disabled:opacity-40">Next page</button>
      </div>
      {reservations.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {reservations.error.message}
          <button type="button" className="ml-3 underline" onClick={() => void reservations.refetch()}>Retry reservations</button>
        </p>
      ) : null}
      {createOpen && property ? (
        <CreateReservationDialog
          property={property}
          permissions={me?.permissions ?? []}
          onClose={() => setCreateOpen(false)}
          onDone={async () => {
            setCreateOpen(false);
            await refresh("Reservation created and inventory reserved.");
          }}
        />
      ) : null}
      {checkInFor && property ? (
        <CheckInDialog
          propertyId={property.id}
          reservation={checkInFor}
          allowDirtyOverride={["TENANT_OWNER", "GENERAL_MANAGER"].includes(
            me?.role ?? "",
          )}
          onClose={() => setCheckInFor(null)}
          onDone={async () => {
            setCheckInFor(null);
            await refresh("Guest checked in and room state updated.");
          }}
        />
      ) : null}
      {folioFor ? (
        <FolioDialog
          reservation={folioFor}
          permissions={me?.permissions ?? []}
          onClose={() => setFolioFor(null)}
          onChanged={() => refresh()}
        />
      ) : null}
    </div>
  );
}
