"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";

interface Task {
  id: string;
  type: string;
  priority: string;
  status: string;
  notes: string | null;
  version: number;
  room: { roomNumber: string; operationalStatus: string };
}
const columns = ["PENDING", "IN_PROGRESS", "COMPLETED", "INSPECTED"];

export default function HousekeepingPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canInspect = ["TENANT_OWNER", "GENERAL_MANAGER"].includes(
    me?.role ?? "",
  );
  const canUpdate = me?.permissions.includes("housekeeping.update") ?? false;
  const [error, setError] = useState("");
  const tasks = useQuery({
    queryKey: ["housekeeping", propertyId],
    queryFn: () =>
      api<Task[]>(
        `/housekeeping/tasks?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const advance = useMutation({
    mutationFn: (taskId: string) =>
      api(`/housekeeping/tasks/${taskId}/advance`, {
        method: "POST",
        body: {},
      }),
    onSuccess: async () => {
      setError("");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["housekeeping", propertyId],
        }),
        queryClient.invalidateQueries({ queryKey: ["room-rack", propertyId] }),
      ]);
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Task could not be advanced.",
      ),
  });

  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">
            Housekeeping Board
          </h1>
          <p className="mt-1 text-sm text-ink/55">
            Advance a task through the live workflow. Inspection is restricted
            to supervisors.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void tasks.refetch()}
          disabled={tasks.isFetching}
          className="rounded-full bg-white px-4 py-2 text-xs font-semibold shadow-sm disabled:opacity-50"
        >
          {tasks.isFetching ? "Refreshing…" : "Refresh"}
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
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((column) => {
          const items = (tasks.data ?? []).filter(
            (task) => task.status === column,
          );
          return (
            <section key={column}>
              <h2 className="mb-3 text-xs font-bold tracking-wider text-ink/45">
                {column.replaceAll("_", " ")} ({items.length})
              </h2>
              <div className="space-y-3">
                {items.map((task) => {
                  const supervisorOnly = column === "COMPLETED" && !canInspect;
                  const finished = column === "INSPECTED";
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => advance.mutate(task.id)}
                      disabled={
                        finished ||
                        supervisorOnly ||
                        !canUpdate ||
                        advance.isPending
                      }
                      title={
                        supervisorOnly
                          ? "A supervisor must inspect this task"
                          : undefined
                      }
                      className="w-full rounded-2xl border border-ink/5 bg-white p-5 text-left shadow-sm transition enabled:hover:-translate-y-0.5 enabled:hover:shadow-md disabled:cursor-default"
                    >
                      <div className="flex justify-between gap-3">
                        <strong>Room {task.room.roomNumber}</strong>
                        <span
                          className={`rounded-full px-2 py-1 text-[10px] font-bold ${task.priority === "HIGH" ? "bg-red-50 text-red-700" : "bg-brand-50 text-brand-700"}`}
                        >
                          {task.priority}
                        </span>
                      </div>
                      <p className="mt-2 text-xs font-semibold text-brand-700">
                        {task.type.replaceAll("_", " ")}
                      </p>
                      {task.notes ? (
                        <p className="mt-2 text-xs text-ink/50">{task.notes}</p>
                      ) : null}
                      {supervisorOnly ? (
                        <p className="mt-3 text-xs text-gold-600">
                          Supervisor inspection required
                        </p>
                      ) : !finished && canUpdate ? (
                        <p className="mt-3 text-xs font-semibold text-ink/45">
                          Click to advance
                        </p>
                      ) : null}
                    </button>
                  );
                })}
                {!items.length ? (
                  <p className="rounded-2xl border border-dashed border-ink/10 px-4 py-8 text-center text-xs text-ink/40">
                    No tasks
                  </p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      {tasks.isError ? (
        <p className="rounded-xl bg-red-50 p-4 text-sm text-red-700">
          {tasks.error.message}
        </p>
      ) : null}
    </div>
  );
}
