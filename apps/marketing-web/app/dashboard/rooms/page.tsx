"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BedDouble } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { naira, type MoneyMinor } from "@/lib/api/money";

interface RackRoom {
  id: string;
  roomNumber: string;
  floor: number;
  operationalStatus: string;
  roomType: { code: string; name: string; baseRateMinor: MoneyMinor };
  occupant: {
    guest: string;
    confirmationCode: string;
    departureDate: string;
  } | null;
}

const nextState: Record<string, string> = {
  VACANT_DIRTY: "VACANT_CLEAN",
  VACANT_CLEAN: "INSPECTED",
  OCCUPIED_DIRTY: "OCCUPIED_CLEAN",
};
const stateColor: Record<string, string> = {
  VACANT_CLEAN: "border-emerald-200 bg-emerald-50",
  INSPECTED: "border-brand-200 bg-brand-50",
  VACANT_DIRTY: "border-amber-200 bg-amber-50",
  OCCUPIED_CLEAN: "border-blue-200 bg-blue-50",
  OCCUPIED_DIRTY: "border-orange-200 bg-orange-50",
  OUT_OF_ORDER: "border-red-200 bg-red-50",
  OUT_OF_SERVICE: "border-slate-200 bg-slate-100",
};

export default function RoomsPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canUpdate = me?.permissions.includes("housekeeping.update") ?? false;
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [notice, setNotice] = useState("");
  const rooms = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const update = useMutation({
    mutationFn: ({ roomId, status }: { roomId: string; status: string }) =>
      api(`/rooms/${roomId}/status`, { method: "PATCH", body: { status } }),
    onSuccess: async (_, variables) => {
      setError("");
      setNotice(`Room updated to ${variables.status.replaceAll("_", " ").toLowerCase()}.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["room-rack", propertyId] }),
        queryClient.invalidateQueries({ queryKey: ["housekeeping", propertyId] }),
        queryClient.invalidateQueries({ queryKey: ["reservation-availability", propertyId] }),
      ]);
    },
    onError: (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Room status could not be updated.",
      ),
  });
  const matchingRooms = (rooms.data ?? []).filter((room) =>
    (status === "ALL" || room.operationalStatus === status) &&
    `${room.roomNumber} ${room.roomType.name} ${room.occupant?.guest ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const floors = [
    ...new Set(matchingRooms.map((room) => room.floor)),
  ].sort((a, b) => a - b);

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Room Rack</h1>
          <p className="mt-1 text-sm text-ink/55">
            Live occupancy and housekeeping state. Vacant rooms advance dirty →
            clean → inspected.
          </p>
        </div>
        <span className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink/60 shadow-sm">
          {rooms.data?.length ?? 0} rooms
        </span>
      </header>
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4">
        <label className="text-sm">Search rooms
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Room, type, or guest" className="ml-2 rounded-lg border border-ink/10 p-2" />
        </label>
        <label className="text-sm">Room status
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="ml-2 rounded-lg border border-ink/10 p-2">
            <option value="ALL">All statuses</option>
            {Object.keys(stateColor).map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void rooms.refetch()} disabled={rooms.isFetching} className="rounded-lg border border-ink/10 px-3 py-2 text-sm">{rooms.isFetching ? "Refreshing…" : "Refresh rooms"}</button>
      </div>
      {notice ? <p role="status" className="rounded-xl bg-brand-50 p-3 text-sm text-brand-700">{notice}</p> : null}
      {rooms.isPending ? <p role="status">Loading rooms…</p> : null}
      {error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
        </button>
      ) : null}
      {rooms.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {rooms.error.message}
        </p>
      ) : null}
      {floors.map((floor) => (
        <section key={floor}>
          <h2 className="mb-3 text-xs font-bold tracking-wider text-ink/45">
            FLOOR {floor}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {matchingRooms
              .filter((room) => room.floor === floor)
              .map((room) => {
                const next = nextState[room.operationalStatus];
                return (
                  <article
                    key={room.id}
                    className={`rounded-2xl border p-5 text-left transition enabled:hover:-translate-y-0.5 enabled:hover:shadow-md disabled:cursor-default ${stateColor[room.operationalStatus] ?? "border-ink/10 bg-white"}`}
                    title={
                      next && canUpdate
                        ? `Mark ${next.replaceAll("_", " ")}`
                        : room.operationalStatus.replaceAll("_", " ")
                    }
                  >
                    <div className="flex items-start justify-between">
                      <span className="font-display text-2xl font-semibold">
                        {room.roomNumber}
                      </span>
                      <BedDouble className="h-5 w-5 text-ink/35" />
                    </div>
                    <p className="mt-1 text-sm text-ink/60">
                      {room.roomType.name}
                    </p>
                    <p className="mt-4 text-[11px] font-bold tracking-wide text-ink/55">
                      {room.operationalStatus.replaceAll("_", " ")}
                    </p>
                    <p className="mt-2 text-xs text-ink/55">
                      {room.occupant
                        ? `${room.occupant.guest} · departs ${room.occupant.departureDate}`
                        : `${naira(room.roomType.baseRateMinor)} / night`}
                    </p>
                    {next && canUpdate ? (
                      <button type="button" disabled={update.isPending} onClick={() => update.mutate({ roomId: room.id, status: next })} aria-label={`Mark room ${room.roomNumber} ${next.replaceAll("_", " ").toLowerCase()}`} className="mt-3 rounded-lg border border-brand-200 px-3 py-2 text-xs font-semibold text-brand-700 disabled:opacity-50">
                        Mark {next.replaceAll("_", " ").toLowerCase()}
                      </button>
                    ) : null}
                    {room.occupant && me?.permissions.includes("reservation.read") ? <Link href={`/dashboard/reservations?search=${encodeURIComponent(room.occupant.confirmationCode)}`} className="mt-3 block text-xs font-semibold text-brand-700 underline">View reservation</Link> : null}
                  </article>
                );
              })}
          </div>
        </section>
      ))}
      {rooms.isSuccess && !rooms.data.length ? (
        <p className="rounded-2xl bg-white p-10 text-center text-sm text-ink/45">
          No rooms are configured for this property. Add rooms in Settings.
        </p>
      ) : null}
      {rooms.isSuccess && rooms.data.length > 0 && !matchingRooms.length ? <p className="p-8 text-center text-sm">No rooms match these filters. <button type="button" className="underline" onClick={() => { setSearch(""); setStatus("ALL"); }}>Clear filters</button></p> : null}
    </div>
  );
}
