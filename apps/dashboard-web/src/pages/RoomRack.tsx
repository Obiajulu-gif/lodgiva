import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

interface RackRoom {
  id: string;
  roomNumber: string;
  floor: number;
  operationalStatus: string;
  roomType: { code: string; name: string; baseRateMinor: number };
  occupant: { guest: string; confirmationCode: string; departureDate: string } | null;
}

const NEXT_STATE: Record<string, string> = {
  VACANT_DIRTY: "VACANT_CLEAN",
  VACANT_CLEAN: "INSPECTED",
};

export default function RoomRackPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const { data: rooms } = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
    refetchInterval: 10_000,
  });

  const setStatus = useMutation({
    mutationFn: ({ roomId, status }: { roomId: string; status: string }) =>
      api(`/rooms/${roomId}/status`, { method: "PATCH", body: { status } }),
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
    },
    onError: (reason) =>
      setError(reason instanceof ApiError ? reason.message : String(reason)),
  });

  const floors = [...new Set((rooms ?? []).map((r) => r.floor))].sort();

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Room Rack</h1>
          <p className="sub">
            Live room states from the API. Click a vacant room to advance its
            cleaning state (dirty → clean → inspected).
          </p>
        </div>
        <span className="badge">{rooms?.length ?? 0} rooms</span>
      </div>

      {error && (
        <button className="error-box error-button" type="button" onClick={() => setError("")}>
          {error} (tap to dismiss)
        </button>
      )}

      {floors.map((floor) => (
        <div key={floor} className="mt">
          <h3 style={{ margin: "8px 0 10px", color: "var(--ink-50)", fontSize: 12 }}>
            FLOOR {floor}
          </h3>
          <div className="room-grid">
            {(rooms ?? [])
              .filter((r) => r.floor === floor)
              .map((r) => {
                const next = NEXT_STATE[r.operationalStatus];
                return (
                  <button
                    key={r.id}
                    className={`room ${r.operationalStatus}`}
                    type="button"
                    disabled={!next || setStatus.isPending}
                    title={next ? `Mark ${next.replace("_", " ")}` : undefined}
                    onClick={() =>
                      next && setStatus.mutate({ roomId: r.id, status: next })
                    }
                  >
                    <div className="num">{r.roomNumber}</div>
                    <div>{r.roomType.name}</div>
                    <div className="state">{r.operationalStatus.replace(/_/g, " ")}</div>
                    <div className="guest">
                      {r.occupant
                        ? `${r.occupant.guest} → ${r.occupant.departureDate}`
                        : `${naira(r.roomType.baseRateMinor)}/night`}
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </>
  );
}
