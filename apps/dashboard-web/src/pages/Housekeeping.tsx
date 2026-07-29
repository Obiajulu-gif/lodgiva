import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { enqueue, flush, isConnectivityFailure, readQueue } from "../offline";

interface Task {
  id: string;
  type: string;
  priority: string;
  status: string;
  notes: string | null;
  businessDate: string;
  version: number;
  room: { roomNumber: string; operationalStatus: string };
}

// Maps the next board column to the offline sync action name.
const ACTION_FOR: Record<string, string> = {
  IN_PROGRESS: "start",
  COMPLETED: "complete",
  INSPECTED: "inspect",
};

const COLUMNS = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"];

export default function HousekeepingPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const { data: tasks } = useQuery({
    queryKey: ["hk-tasks", propertyId],
    queryFn: () => api<Task[]>(`/housekeeping/tasks?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });

  const advance = useMutation({
    // Offline-first: when there is no connection the change is queued with the
    // version this device saw and replayed through /sync/mutations later.
    mutationFn: async (task: Task) => {
      const idx = COLUMNS.indexOf(task.status);
      const next = COLUMNS[idx + 1];
      if (!next) return;

      const queueIt = () =>
        enqueue({
          entityType: "housekeepingTask",
          entityId: task.id,
          baseVersion: task.version,
          action: ACTION_FOR[next],
          payload: {},
          label: `Room ${task.room.roomNumber} → ${next.replace("_", " ")}`,
        });

      // Known-offline: don't even attempt the request.
      if (!navigator.onLine) return void queueIt();

      try {
        await api(`/housekeeping/tasks/${task.id}/advance`, { method: "POST", body: {} });
      } catch (err) {
        // The server was unreachable — queue it rather than losing the work.
        // A genuine rejection (409, 404, …) still surfaces as an error.
        if (isConnectivityFailure(err)) return void queueIt();
        throw err;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hk-tasks", propertyId] });
      qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
    },
  });

  const queuedFor = (taskId: string) =>
    readQueue().filter((q) => q.entityId === taskId).length;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Housekeeping Board</h1>
          <p className="sub">
            Click a card to advance it. Completing a task updates the room's
            state on the rack. Works offline — changes queue and sync on
            reconnect.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          <span className="badge">{tasks?.length ?? 0} tasks</span>
          <button className="secondary small" onClick={() => flush().then(() => qc.invalidateQueries())}>
            Sync now
          </button>
        </div>
      </div>

      <div className="grid cols-4">
        {COLUMNS.map((col) => {
          const colTasks = (tasks ?? []).filter((t) => t.status === col);
          return (
            <div key={col}>
              <h3 style={{ fontSize: 12, color: "var(--ink-50)", margin: "0 0 10px" }}>
                {col.replace("_", " ")} ({colTasks.length})
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {colTasks.map((t) => (
                  <div
                    key={t.id}
                    className="card"
                    style={{ cursor: col !== "INSPECTED" ? "pointer" : "default", padding: 14 }}
                    onClick={() => col !== "INSPECTED" && advance.mutate(t)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <b>
                        Room {t.room.roomNumber}
                        {queuedFor(t.id) > 0 && (
                          <span className="pill gold" style={{ marginLeft: 6 }}>queued</span>
                        )}
                      </b>
                      <span className={`pill ${t.priority === "HIGH" ? "red" : t.priority === "LOW" ? "gray" : "blue"}`}>
                        {t.priority}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--brand-700)", marginTop: 4 }}>
                      {t.type.replace("_", " ")}
                    </div>
                    {t.notes && (
                      <div style={{ fontSize: 11, color: "var(--ink-50)", marginTop: 6 }}>
                        {t.notes}
                      </div>
                    )}
                  </div>
                ))}
                {!colTasks.length && (
                  <div style={{
                    border: "1px dashed var(--border)", borderRadius: 12,
                    padding: "24px 0", textAlign: "center", fontSize: 12, color: "var(--ink-50)",
                  }}>
                    No tasks
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
