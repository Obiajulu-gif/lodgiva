import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

interface Task {
  id: string;
  type: string;
  priority: string;
  status: string;
  notes: string | null;
  businessDate: string;
  room: { roomNumber: string; operationalStatus: string };
}

const COLUMNS = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"];

export default function HousekeepingPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const { data: tasks } = useQuery({
    queryKey: ["hk-tasks", propertyId],
    queryFn: () => api<Task[]>(`/housekeeping/tasks?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });

  const advance = useMutation({
    mutationFn: (id: string) =>
      api(`/housekeeping/tasks/${id}/advance`, { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hk-tasks", propertyId] });
      qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
    },
  });

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Housekeeping Board</h1>
          <p className="sub">
            Click a card to advance it. Completing a task updates the room's
            state on the rack automatically.
          </p>
        </div>
        <span className="badge">{tasks?.length ?? 0} tasks</span>
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
                    onClick={() => col !== "INSPECTED" && advance.mutate(t.id)}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <b>Room {t.room.roomNumber}</b>
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
