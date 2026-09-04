"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";

interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  source: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  guest: { firstName: string; lastName: string; vip: boolean };
  rooms: { room: { roomNumber: string } | null }[];
}

export default function ReservationsPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canCancel = me?.permissions.includes("reservation.cancel") ?? false;
  const canCheckOut = me?.permissions.includes("frontdesk.check_out") ?? false;
  const [error, setError] = useState("");
  const reservations = useQuery({
    queryKey: ["reservations", propertyId],
    queryFn: () =>
      api<Reservation[]>(
        `/reservations?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const action = useMutation({
    mutationFn: ({
      id,
      operation,
    }: {
      id: string;
      operation: "cancel" | "check-out";
    }) =>
      api(`/reservations/${id}/${operation}`, {
        method: "POST",
        body:
          operation === "cancel" ? { reason: "Cancelled from dashboard" } : {},
      }),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({
        queryKey: ["reservations", propertyId],
      });
    },
    onError: (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Reservation could not be updated.",
      ),
  });
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Reservations</h1>
          <p className="mt-1 text-sm text-ink/55">
            Live stays, arrivals, departures, and lifecycle actions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reservations.refetch()}
          className="rounded-full bg-brand-800 px-4 py-2 text-xs font-semibold text-white"
        >
          Refresh reservations
        </button>
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
      <section className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Guest</th>
                <th className="px-4 py-3 font-medium">Room</th>
                <th className="px-4 py-3 font-medium">Stay</th>
                <th className="px-4 py-3 font-medium">Guests</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-6 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(reservations.data ?? []).map((reservation) => (
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
                      .map((item) => item.room?.roomNumber)
                      .filter(Boolean)
                      .join(", ") || "Unassigned"}
                  </td>
                  <td className="px-4 py-4 whitespace-nowrap text-ink/60">
                    {reservation.arrivalDate} → {reservation.departureDate}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {reservation.adults} adult
                    {reservation.adults === 1 ? "" : "s"}
                    {reservation.children
                      ? ` · ${reservation.children} children`
                      : ""}
                  </td>
                  <td className="px-4 py-4">
                    <span className="rounded-full bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
                      {reservation.status.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      {reservation.status === "CHECKED_IN" && canCheckOut ? (
                        <button
                          type="button"
                          disabled={action.isPending}
                          onClick={() =>
                            action.mutate({
                              id: reservation.id,
                              operation: "check-out",
                            })
                          }
                          className="rounded-lg bg-brand-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                        >
                          Check out
                        </button>
                      ) : null}
                      {canCancel &&
                      ["CONFIRMED", "HOLD", "PENDING_PAYMENT"].includes(
                        reservation.status,
                      ) ? (
                        <button
                          type="button"
                          disabled={action.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel reservation ${reservation.confirmationCode}?`,
                              )
                            )
                              action.mutate({
                                id: reservation.id,
                                operation: "cancel",
                              });
                          }}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!reservations.isPending && !reservations.data?.length ? (
          <p className="p-10 text-center text-sm text-ink/45">
            No reservations have been recorded for this property.
          </p>
        ) : null}
      </section>
      {reservations.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {reservations.error.message}
        </p>
      ) : null}
    </div>
  );
}
