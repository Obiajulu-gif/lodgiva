"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { BedDouble } from "lucide-react";
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
  const rooms = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const update = useMutation({
    mutationFn: ({ roomId, status }: { roomId: string; status: string }) =>
      api(`/rooms/${roomId}/status`, { method: "PATCH", body: { status } }),
    onSuccess: async () => {
      setError("");
      await queryClient.invalidateQueries({
        queryKey: ["room-rack", propertyId],
      });
    },
    onError: (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Room status could not be updated.",
      ),
  });
  const floors = [
    ...new Set((rooms.data ?? []).map((room) => room.floor)),
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
            {(rooms.data ?? [])
              .filter((room) => room.floor === floor)
              .map((room) => {
                const next = nextState[room.operationalStatus];
                return (
                  <button
                    key={room.id}
                    type="button"
                    disabled={!next || !canUpdate || update.isPending}
                    onClick={() =>
                      next &&
                      canUpdate &&
                      update.mutate({ roomId: room.id, status: next })
                    }
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
                      <p className="mt-3 text-xs font-semibold text-brand-700">
                        Click to mark {next.replaceAll("_", " ").toLowerCase()}
                      </p>
                    ) : null}
                  </button>
                );
              })}
          </div>
        </section>
      ))}
      {!rooms.isPending && !rooms.data?.length ? (
        <p className="rounded-2xl bg-white p-10 text-center text-sm text-ink/45">
          No rooms are configured for this property. Add rooms in Settings.
        </p>
      ) : null}
    </div>
  );
}
