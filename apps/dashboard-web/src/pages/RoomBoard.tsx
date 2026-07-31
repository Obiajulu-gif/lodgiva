import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, stalenessFor } from "../api";
import { ageLabel } from "../cache";
import { enqueue, flush, isConnectivityFailure, readQueue } from "../offline";

/**
 * Mobile-first room board.
 *
 * This is the screen a housekeeper holds in one hand in a corridor, on a
 * cheap Android phone, often with no signal. Everything here follows from
 * that: one column on a phone, targets big enough for a thumb, no horizontal
 * scrolling, and every action queues rather than failing when the network is
 * gone.
 */

interface Task {
  id: string;
  type: string;
  priority: string;
  status: string;
  notes: string | null;
  version: number;
  room: { roomNumber: string; operationalStatus: string };
}

const FLOW = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"] as const;
const ACTION_FOR: Record<string, string> = {
  IN_PROGRESS: "start",
  COMPLETED: "complete",
  INSPECTED: "inspect",
};
const NEXT_LABEL: Record<string, string> = {
  PENDING: "Start cleaning",
  IN_PROGRESS: "Mark clean",
  COMPLETED: "Pass inspection",
};
const STATUS_PILL: Record<string, string> = {
  PENDING: "gold",
  IN_PROGRESS: "blue",
  COMPLETED: "green",
  INSPECTED: "gray",
};

export default function RoomBoardPage({
  propertyId,
  canInspect,
}: {
  propertyId: string;
  canInspect: boolean;
}) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("ACTIVE");
  const [error, setError] = useState("");
  const [noteFor, setNoteFor] = useState<Task | null>(null);

  const tasksPath = `/housekeeping/tasks?propertyId=${propertyId}`;
  const { data: tasks } = useQuery({
    queryKey: ["hk-tasks", propertyId],
    queryFn: () => api<Task[]>(tasksPath),
    refetchInterval: 15_000,
  });
  const stale = stalenessFor(tasksPath);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["hk-tasks", propertyId] });
    qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
  };

  const advance = useMutation({
    mutationFn: async (task: Task) => {
      const next = FLOW[FLOW.indexOf(task.status as (typeof FLOW)[number]) + 1];
      if (!next) return;
      const queueIt = () =>
        enqueue({
          entityType: "housekeepingTask",
          entityId: task.id,
          baseVersion: task.version,
          action: ACTION_FOR[next],
          payload: {},
          label: `Room ${task.room.roomNumber} → ${next.replace("_", " ").toLowerCase()}`,
        });
      if (!navigator.onLine) return void queueIt();
      try {
        await api(`/housekeeping/tasks/${task.id}/advance`, { method: "POST", body: {} });
      } catch (err) {
        if (isConnectivityFailure(err)) return void queueIt();
        throw err;
      }
    },
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const addNote = useMutation({
    mutationFn: async ({ task, note }: { task: Task; note: string }) => {
      const queueIt = () =>
        enqueue({
          entityType: "housekeepingTask",
          entityId: task.id,
          baseVersion: task.version,
          action: "note",
          payload: { notes: note },
          label: `Note on room ${task.room.roomNumber}`,
        });
      if (!navigator.onLine) return void queueIt();
      try {
        await api("/sync/mutations", {
          method: "POST",
          body: {
            deviceId: "board",
            mutations: [
              {
                operationId: `note_${task.id}_${Date.now()}`,
                entityType: "housekeepingTask",
                entityId: task.id,
                baseVersion: task.version,
                action: "note",
                occurredAt: new Date().toISOString(),
                payload: { notes: note },
              },
            ],
          },
        });
      } catch (err) {
        if (isConnectivityFailure(err)) return void queueIt();
        throw err;
      }
    },
    onSuccess: () => {
      setNoteFor(null);
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const queuedIds = new Set(readQueue().map((q) => q.entityId));
  const visible = (tasks ?? []).filter((t) =>
    filter === "ACTIVE"
      ? t.status !== "INSPECTED"
      : filter === "ALL"
        ? true
        : t.status === filter
  );
  const counts = FLOW.reduce<Record<string, number>>((acc, s) => {
    acc[s] = (tasks ?? []).filter((t) => t.status === s).length;
    return acc;
  }, {});

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Room Board</h1>
          <p className="sub">
            {counts.PENDING ?? 0} to start · {counts.IN_PROGRESS ?? 0} in progress ·{" "}
            {counts.COMPLETED ?? 0} awaiting inspection
          </p>
        </div>
        <button className="secondary small" onClick={() => flush().then(refresh)}>
          Sync now
        </button>
      </div>

      {stale.fromCache && (
        // Never let someone act on stale data without knowing it is stale.
        <div
          className="card"
          style={{
            marginBottom: 12,
            padding: "10px 14px",
            background: "var(--gold-100)",
            borderColor: "var(--gold-300)",
            fontSize: 13,
          }}
        >
          Showing an offline copy from {stale.cachedAt ? ageLabel(stale.cachedAt) : "earlier"}.
          Your changes are queued and will sync when you reconnect.
        </div>
      )}

      {error && (
        <div className="error-box" onClick={() => setError("")}>
          {error} (tap to dismiss)
        </div>
      )}

      <div className="toolbar" style={{ overflowX: "auto", flexWrap: "nowrap" }}>
        {["ACTIVE", ...FLOW, "ALL"].map((f) => (
          <button
            key={f}
            className={filter === f ? "small" : "small secondary"}
            style={{ whiteSpace: "nowrap" }}
            onClick={() => setFilter(f)}
          >
            {f === "ACTIVE" ? "To do" : f === "ALL" ? "All" : f.replace("_", " ").toLowerCase()}
            {f !== "ACTIVE" && f !== "ALL" ? ` (${counts[f] ?? 0})` : ""}
          </button>
        ))}
      </div>

      {/* One column on a phone, more as the screen allows. */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))",
        }}
      >
        {visible.map((t) => {
          const next = FLOW[FLOW.indexOf(t.status as (typeof FLOW)[number]) + 1];
          const inspectionStep = next === "INSPECTED";
          const blocked = inspectionStep && !canInspect;
          const queued = queuedIds.has(t.id);
          return (
            <div key={t.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.1 }}>
                    {t.room.roomNumber}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--ink-50)", marginTop: 2 }}>
                    {t.type.replace(/_/g, " ").toLowerCase()}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "end" }}>
                  <span className={`pill ${STATUS_PILL[t.status]}`}>
                    {t.status.replace("_", " ").toLowerCase()}
                  </span>
                  {t.priority === "HIGH" && <span className="pill red">priority</span>}
                  {queued && <span className="pill gold">queued</span>}
                </div>
              </div>

              {t.notes && (
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 12,
                    color: "var(--ink-50)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {t.notes}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                {next && (
                  <button
                    // Thumb-sized: this is tapped while holding a phone in a
                    // corridor, not clicked with a mouse.
                    style={{ flex: 1, padding: "14px 12px", fontSize: 15 }}
                    disabled={blocked || advance.isPending}
                    onClick={() => advance.mutate(t)}
                    title={blocked ? "Inspection requires a supervisor" : undefined}
                  >
                    {blocked ? "Supervisor only" : NEXT_LABEL[t.status]}
                  </button>
                )}
                <button
                  className="secondary"
                  style={{ padding: "14px 16px", fontSize: 15 }}
                  onClick={() => setNoteFor(t)}
                >
                  Note
                </button>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div
            className="card"
            style={{ padding: 28, textAlign: "center", color: "var(--ink-50)" }}
          >
            Nothing here. Pull down or tap Sync to refresh.
          </div>
        )}
      </div>

      {noteFor && (
        <NoteModal
          task={noteFor}
          busy={addNote.isPending}
          onClose={() => setNoteFor(null)}
          onSave={(note) => addNote.mutate({ task: noteFor, note })}
        />
      )}
    </>
  );
}

function NoteModal({
  task,
  busy,
  onClose,
  onSave,
}: {
  task: Task;
  busy: boolean;
  onClose: () => void;
  onSave: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Note — room {task.room.roomNumber}</h2>
        <p style={{ fontSize: 12, color: "var(--ink-50)", marginBottom: 10 }}>
          Notes are appended, never overwritten, so two people adding notes at
          once cannot lose each other&apos;s work.
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="e.g. Kettle missing, reported to maintenance"
          style={{
            width: "100%",
            font: "inherit",
            padding: 12,
            borderRadius: 10,
            border: "1px solid var(--border)",
            resize: "vertical",
          }}
        />
        <div className="row mt">
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button disabled={!note.trim() || busy} onClick={() => onSave(note.trim())}>
            Save note
          </button>
        </div>
      </div>
    </div>
  );
}
