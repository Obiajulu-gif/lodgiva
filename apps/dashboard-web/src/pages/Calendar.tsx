import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

/**
 * Reservation calendar — the room-by-night grid a front office actually works
 * from. Rows are physical rooms, columns are nights, and a stay is drawn as a
 * bar spanning the nights it occupies.
 *
 * Unassigned stays are shown in a separate tray above the grid rather than
 * hidden: a booking with no room is the thing a GM most needs to see before
 * arrivals start.
 */

interface RackRoom {
  id: string;
  roomNumber: string;
  floor: number;
  operationalStatus: string;
  roomTypeId: string;
  roomType: { code: string; name: string };
}

interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  guest: { firstName: string; lastName: string; vip: boolean };
  rooms: { roomId: string | null; roomTypeId: string; room: { roomNumber: string } | null }[];
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  CONFIRMED: { bg: "var(--brand-600)", fg: "#fff", label: "Confirmed" },
  CHECKED_IN: { bg: "var(--brand-800)", fg: "#fff", label: "In house" },
  CHECKED_OUT: { bg: "rgba(16,28,23,0.28)", fg: "#fff", label: "Departed" },
  PENDING_PAYMENT: { bg: "var(--gold-400)", fg: "#0c3527", label: "Awaiting payment" },
  HOLD: { bg: "var(--gold-300)", fg: "#0c3527", label: "Held" },
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number) => {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const dayDiff = (a: string, b: string) =>
  Math.round(
    (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000
  );

const CELL = 44;
const DAYS = 14;

export default function CalendarPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [start, setStart] = useState(() => iso(new Date()));
  const [selected, setSelected] = useState<Reservation | null>(null);
  const [error, setError] = useState("");

  const days = useMemo(
    () => Array.from({ length: DAYS }, (_, i) => addDays(start, i)),
    [start]
  );
  const end = addDays(start, DAYS);

  const { data: rooms } = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
  });
  const { data: reservations } = useQuery({
    queryKey: ["reservations", propertyId],
    queryFn: () => api<Reservation[]>(`/reservations?propertyId=${propertyId}`),
    refetchInterval: 20_000,
  });

  const assign = useMutation({
    mutationFn: ({ id, roomId }: { id: string; roomId?: string }) =>
      api(`/reservations/${id}/assign-room`, {
        method: "POST",
        body: roomId ? { roomId } : {},
      }),
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["reservations", propertyId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  /**
   * Moving a stay between rooms.
   *
   * An in-house guest goes through room-move (which turns the old room dirty
   * and raises a housekeeping task); a future booking is just re-assigned.
   * Using the wrong endpoint would either skip housekeeping or refuse
   * outright, so the status decides.
   */
  const move = useMutation({
    mutationFn: async ({ res, roomId }: { res: Reservation; roomId: string }) => {
      if (res.status === "CHECKED_IN") {
        return api(`/reservations/${res.id}/room-move`, {
          method: "POST",
          body: { roomId, reason: "Moved on the calendar" },
        });
      }
      return api(`/reservations/${res.id}/assign-room`, {
        method: "POST",
        body: { roomId },
      });
    },
    onSuccess: () => {
      setError("");
      qc.invalidateQueries({ queryKey: ["reservations", propertyId] });
      qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const [dragging, setDragging] = useState<Reservation | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /**
   * A room can receive the dragged stay only if it is the right type, not the
   * room it already occupies, and free for those nights. Computing this during
   * the drag lets invalid rooms be greyed out instead of failing on drop.
   */
  const canDrop = (room: RackRoom, res: Reservation | null) => {
    if (!res) return false;
    if (res.rooms[0]?.roomId === room.id) return false;
    if (room.roomTypeId !== res.rooms[0]?.roomTypeId) return false;
    if (["OUT_OF_ORDER", "OUT_OF_SERVICE"].includes(room.operationalStatus)) return false;
    const occupants = byRoom.get(room.id) ?? [];
    return !occupants.some(
      (o) => o.id !== res.id && o.arrivalDate < res.departureDate && o.departureDate > res.arrivalDate
    );
  };

  // Only stays that overlap the visible window, and only those that still
  // hold a room — cancelled and no-show bookings must not occupy the grid.
  const visible = (reservations ?? []).filter(
    (r) =>
      !["CANCELLED", "NO_SHOW"].includes(r.status) &&
      r.arrivalDate < end &&
      r.departureDate > start
  );
  const byRoom = new Map<string, Reservation[]>();
  const unassigned: Reservation[] = [];
  for (const r of visible) {
    const roomId = r.rooms[0]?.roomId;
    if (!roomId) {
      unassigned.push(r);
      continue;
    }
    byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), r]);
  }

  const floors = [...new Set((rooms ?? []).map((r) => r.floor))].sort();
  const today = iso(new Date());

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Reservation Calendar</h1>
          <p className="sub">
            {days[0]} → {days[DAYS - 1]} · rooms down, nights across. Click a
            stay to see it, or drag it onto another room to move the guest.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <button className="secondary small" onClick={() => setStart(addDays(start, -7))}>
            ← Previous week
          </button>
          <button className="secondary small" onClick={() => setStart(today)}>
            Today
          </button>
          <button className="secondary small" onClick={() => setStart(addDays(start, 7))}>
            Next week →
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" onClick={() => setError("")}>
          {error} (click to dismiss)
        </div>
      )}

      {unassigned.length > 0 && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--gold-300)" }}>
          <h3>
            Awaiting room assignment{" "}
            <span className="pill gold">{unassigned.length}</span>
          </h3>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 10 }}>
            {unassigned.map((r) => (
              <div
                key={r.id}
                className="card"
                draggable
                onDragStart={(e) => {
                  setDragging(r);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", r.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropTarget(null);
                }}
                style={{
                  padding: 12,
                  minWidth: 210,
                  cursor: "grab",
                  opacity: dragging?.id === r.id ? 0.4 : 1,
                }}
                onClick={() => setSelected(r)}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>
                  {r.guest.firstName} {r.guest.lastName} {r.guest.vip ? "★" : ""}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-50)", marginTop: 2 }}>
                  {r.confirmationCode} · {r.arrivalDate} → {r.departureDate}
                </div>
                <button
                  className="small mt"
                  disabled={assign.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    assign.mutate({ id: r.id });
                  }}
                >
                  Auto-assign room
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 180 + DAYS * CELL }}>
            {/* Date header */}
            <div style={{ display: "flex", borderBottom: "1px solid var(--border)" }}>
              <div
                style={{
                  width: 180,
                  flexShrink: 0,
                  padding: "10px 14px",
                  fontSize: 11,
                  color: "var(--ink-50)",
                  fontWeight: 600,
                }}
              >
                ROOM
              </div>
              {days.map((d) => {
                const dt = new Date(d + "T00:00:00Z");
                const weekend = dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
                return (
                  <div
                    key={d}
                    style={{
                      width: CELL,
                      flexShrink: 0,
                      textAlign: "center",
                      padding: "6px 0",
                      fontSize: 10,
                      background: d === today
                        ? "var(--brand-50)"
                        : weekend
                          ? "rgba(16,28,23,0.03)"
                          : undefined,
                      color: d === today ? "var(--brand-700)" : "var(--ink-50)",
                      fontWeight: d === today ? 700 : 500,
                      borderLeft: "1px solid var(--border)",
                    }}
                  >
                    <div>{dt.toLocaleDateString(undefined, { weekday: "narrow" })}</div>
                    <div style={{ fontSize: 12 }}>{d.slice(8)}</div>
                  </div>
                );
              })}
            </div>

            {floors.map((floor) => (
              <div key={floor}>
                <div
                  style={{
                    padding: "5px 14px",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    color: "var(--ink-50)",
                    background: "var(--cream)",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  FLOOR {floor}
                </div>
                {(rooms ?? [])
                  .filter((r) => r.floor === floor)
                  .map((room) => {
                    const stays = byRoom.get(room.id) ?? [];
                    const ooo = ["OUT_OF_ORDER", "OUT_OF_SERVICE"].includes(
                      room.operationalStatus
                    );
                    return (
                      <div
                        key={room.id}
                        onDragOver={(e) => {
                          if (!canDrop(room, dragging)) return;
                          e.preventDefault(); // signals "this is a valid drop"
                          e.dataTransfer.dropEffect = "move";
                          if (dropTarget !== room.id) setDropTarget(room.id);
                        }}
                        onDragLeave={() => {
                          if (dropTarget === room.id) setDropTarget(null);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const res = dragging;
                          setDragging(null);
                          setDropTarget(null);
                          if (res && canDrop(room, res)) move.mutate({ res, roomId: room.id });
                        }}
                        style={{
                          display: "flex",
                          borderBottom: "1px solid var(--border)",
                          position: "relative",
                          height: 40,
                          background:
                            dropTarget === room.id
                              ? "var(--brand-100)"
                              : dragging && !canDrop(room, dragging)
                                ? "rgba(16,28,23,0.04)"
                                : undefined,
                          outline:
                            dropTarget === room.id ? "2px solid var(--brand-600)" : undefined,
                          outlineOffset: -2,
                          transition: "background 120ms ease",
                        }}
                      >
                        <div
                          style={{
                            width: 180,
                            flexShrink: 0,
                            padding: "0 14px",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            fontSize: 13,
                          }}
                        >
                          <b>{room.roomNumber}</b>
                          <span style={{ fontSize: 11, color: "var(--ink-50)" }}>
                            {room.roomType.code}
                          </span>
                          {ooo && <span className="pill gray">OOO</span>}
                        </div>

                        {/* Night cells */}
                        {days.map((d) => (
                          <div
                            key={d}
                            style={{
                              width: CELL,
                              flexShrink: 0,
                              borderLeft: "1px solid var(--border)",
                              background: ooo
                                ? "repeating-linear-gradient(45deg, rgba(16,28,23,0.05) 0 6px, transparent 6px 12px)"
                                : d === today
                                  ? "var(--brand-50)"
                                  : undefined,
                            }}
                          />
                        ))}

                        {/* Stay bars, positioned over the cells */}
                        {stays.map((r) => {
                          const from = Math.max(0, dayDiff(start, r.arrivalDate));
                          const to = Math.min(DAYS, dayDiff(start, r.departureDate));
                          const width = Math.max(1, to - from);
                          const style = STATUS_STYLE[r.status] ?? {
                            bg: "var(--ink-50)",
                            fg: "#fff",
                            label: r.status,
                          };
                          return (
                            <div
                              key={r.id}
                              draggable={r.status !== "CHECKED_OUT"}
                              onDragStart={(e) => {
                                setDragging(r);
                                e.dataTransfer.effectAllowed = "move";
                                // Firefox will not start a drag without data.
                                e.dataTransfer.setData("text/plain", r.id);
                              }}
                              onDragEnd={() => {
                                setDragging(null);
                                setDropTarget(null);
                              }}
                              onClick={() => setSelected(r)}
                              title={`${r.confirmationCode} · ${r.guest.firstName} ${r.guest.lastName} · ${style.label}${r.status !== "CHECKED_OUT" ? " · drag to another room to move" : ""}`}
                              style={{
                                position: "absolute",
                                left: 180 + from * CELL + 3,
                                width: width * CELL - 6,
                                top: 6,
                                height: 28,
                                background: style.bg,
                                color: style.fg,
                                borderRadius: 8,
                                fontSize: 11,
                                fontWeight: 600,
                                display: "flex",
                                alignItems: "center",
                                padding: "0 8px",
                                overflow: "hidden",
                                whiteSpace: "nowrap",
                                textOverflow: "ellipsis",
                                cursor: r.status === "CHECKED_OUT" ? "pointer" : "grab",
                                zIndex: 2,
                                opacity: dragging?.id === r.id ? 0.4 : 1,
                              }}
                            >
                              {r.guest.vip ? "★ " : ""}
                              {r.guest.lastName}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="toolbar mt">
        {Object.entries(STATUS_STYLE).map(([k, v]) => (
          <span key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
            <span
              style={{ width: 12, height: 12, borderRadius: 4, background: v.bg, display: "inline-block" }}
            />
            {v.label}
          </span>
        ))}
      </div>

      {selected && (
        <StayModal
          reservation={selected}
          rooms={rooms ?? []}
          onClose={() => setSelected(null)}
          onAssign={(roomId) => {
            assign.mutate({ id: selected.id, roomId });
            setSelected(null);
          }}
        />
      )}
    </>
  );
}

function StayModal({
  reservation,
  rooms,
  onClose,
  onAssign,
}: {
  reservation: Reservation;
  rooms: RackRoom[];
  onClose: () => void;
  onAssign: (roomId?: string) => void;
}) {
  const [roomId, setRoomId] = useState(reservation.rooms[0]?.roomId ?? "");
  const { data: detail } = useQuery({
    queryKey: ["reservation", reservation.id],
    queryFn: () => api<{ balanceMinor: number; notes: string | null }>(
      `/reservations/${reservation.id}`
    ),
  });

  const sameType = rooms.filter((r) => r.roomType.code && reservation.rooms[0]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {reservation.guest.firstName} {reservation.guest.lastName}{" "}
          {reservation.guest.vip ? "★" : ""}
        </h2>
        <table>
          <tbody>
            <tr>
              <td style={{ color: "var(--ink-50)" }}>Code</td>
              <td style={{ fontFamily: "monospace" }}>{reservation.confirmationCode}</td>
            </tr>
            <tr>
              <td style={{ color: "var(--ink-50)" }}>Stay</td>
              <td>
                {reservation.arrivalDate} → {reservation.departureDate}
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--ink-50)" }}>Guests</td>
              <td>
                {reservation.adults} adult{reservation.adults > 1 ? "s" : ""}
                {reservation.children ? `, ${reservation.children} children` : ""}
              </td>
            </tr>
            <tr>
              <td style={{ color: "var(--ink-50)" }}>Status</td>
              <td>{(STATUS_STYLE[reservation.status] ?? { label: reservation.status }).label}</td>
            </tr>
            {detail && (
              <tr>
                <td style={{ color: "var(--ink-50)" }}>Balance</td>
                <td>{naira(detail.balanceMinor)}</td>
              </tr>
            )}
          </tbody>
        </table>

        {reservation.status !== "CHECKED_OUT" && (
          <div className="field mt">
            <label>ASSIGN ROOM</label>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              <option value="">— Auto-assign —</option>
              {sameType.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.roomNumber} · {r.roomType.code} ({r.operationalStatus.replace(/_/g, " ")})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="row mt">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
          {reservation.status !== "CHECKED_OUT" && (
            <button onClick={() => onAssign(roomId || undefined)}>Assign room</button>
          )}
        </div>
      </div>
    </div>
  );
}
