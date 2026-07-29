import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api";

interface Ticket {
  id: string;
  title: string;
  priority: string;
  status: string;
  blocksRoom: boolean;
  createdAt: string;
  room: { roomNumber: string; operationalStatus: string } | null;
}
interface RackRoom { id: string; roomNumber: string; operationalStatus: string }

const PRIORITY_PILL: Record<string, string> = {
  URGENT: "red", HIGH: "gold", NORMAL: "blue", LOW: "gray",
};
const NEXT: Record<string, string> = {
  OPEN: "IN_PROGRESS", IN_PROGRESS: "RESOLVED", RESOLVED: "CLOSED",
};

export default function MaintenancePage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", roomId: "", priority: "NORMAL", blocksRoom: false });

  const { data: tickets } = useQuery({
    queryKey: ["tickets", propertyId],
    queryFn: () => api<Ticket[]>(`/maintenance/tickets?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });
  const { data: rooms } = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["tickets", propertyId] });
    qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
  };
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : String(e));

  const create = useMutation({
    mutationFn: () =>
      api("/maintenance/tickets", {
        method: "POST",
        body: {
          propertyId,
          title: form.title,
          roomId: form.roomId || undefined,
          priority: form.priority,
          blocksRoom: form.blocksRoom,
        },
      }),
    onSuccess: () => { setForm({ title: "", roomId: "", priority: "NORMAL", blocksRoom: false }); setError(""); refresh(); },
    onError,
  });

  const advance = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api(`/maintenance/tickets/${id}/status`, { method: "POST", body: { status } }),
    onSuccess: refresh,
    onError,
  });

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Maintenance</h1>
          <p className="sub">
            Blocking a room takes it out of order immediately; resolving sends
            it back through housekeeping before it can be sold.
          </p>
        </div>
      </div>

      {error && <div className="error-box" onClick={() => setError("")}>{error}</div>}

      <div className="card">
        <h3>Raise a ticket</h3>
        <div className="row">
          <div>
            <label>TITLE</label>
            <input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. AC not cooling"
            />
          </div>
          <div>
            <label>ROOM</label>
            <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
              <option value="">— No room —</option>
              {(rooms ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.roomNumber} ({r.operationalStatus.replace(/_/g, " ")})
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>PRIORITY</label>
            <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option>URGENT</option><option>HIGH</option><option>NORMAL</option><option>LOW</option>
            </select>
          </div>
        </div>
        <div className="toolbar mt">
          <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
            <input
              type="checkbox"
              checked={form.blocksRoom}
              onChange={(e) => setForm({ ...form, blocksRoom: e.target.checked })}
              style={{ width: "auto" }}
            />
            Block room (out of order)
          </label>
          <button disabled={!form.title || create.isPending} onClick={() => create.mutate()}>
            Create ticket
          </button>
        </div>
      </div>

      <div className="card mt">
        <h3>Tickets</h3>
        <table>
          <thead>
            <tr><th>Title</th><th>Room</th><th>Priority</th><th>Blocks room</th><th>Status</th><th>Raised</th><th></th></tr>
          </thead>
          <tbody>
            {(tickets ?? []).map((t) => (
              <tr key={t.id}>
                <td>{t.title}</td>
                <td>{t.room?.roomNumber ?? "—"}</td>
                <td><span className={`pill ${PRIORITY_PILL[t.priority]}`}>{t.priority}</span></td>
                <td>{t.blocksRoom ? "Yes" : "No"}</td>
                <td><span className={`pill ${t.status === "OPEN" ? "gold" : t.status === "IN_PROGRESS" ? "blue" : "green"}`}>
                  {t.status.replace("_", " ")}
                </span></td>
                <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                <td>
                  {NEXT[t.status] && (
                    <button
                      className="small secondary"
                      onClick={() => advance.mutate({ id: t.id, status: NEXT[t.status] })}
                    >
                      → {NEXT[t.status].replace("_", " ")}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!tickets?.length && (
              <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>No tickets.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
