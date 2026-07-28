"use client";

import { useState } from "react";
import { housekeepingTasks, type HousekeepingTask } from "@/lib/data";

const columns: HousekeepingTask["status"][] = [
  "Pending",
  "In Progress",
  "Completed",
  "Inspected",
];

const priorityStyles: Record<string, string> = {
  High: "bg-red-50 text-red-600",
  Normal: "bg-blue-50 text-blue-600",
  Low: "bg-ink/5 text-ink/50",
};

export default function HousekeepingPage() {
  const [tasks, setTasks] = useState(housekeepingTasks);

  const advance = (id: string) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const idx = columns.indexOf(t.status);
        if (idx >= columns.length - 1) return t;
        return { ...t, status: columns[idx + 1] };
      })
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold text-ink">
          Housekeeping Board
        </h1>
        <p className="mt-1 text-ink/55">
          Tap a task to advance it to the next stage — changes queue offline
          and sync automatically.
        </p>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        {columns.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col);
          return (
            <div key={col} className="rounded-2xl bg-white/60 p-4">
              <div className="flex items-center justify-between px-2 pb-3">
                <h2 className="text-sm font-semibold text-ink">{col}</h2>
                <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-semibold text-brand-700">
                  {colTasks.length}
                </span>
              </div>
              <div className="space-y-3">
                {colTasks.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => advance(t.id)}
                    disabled={t.status === "Inspected"}
                    className="w-full rounded-xl border border-ink/5 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:cursor-default disabled:hover:translate-y-0"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-display text-lg font-semibold text-ink">
                        Room {t.room}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${priorityStyles[t.priority]}`}
                      >
                        {t.priority}
                      </span>
                    </div>
                    <p className="mt-1 text-xs font-medium text-brand-700">
                      {t.type}
                    </p>
                    <p className="mt-2 text-xs text-ink/50">{t.assignee}</p>
                    {t.notes && (
                      <p className="mt-2 rounded-lg bg-cream px-2.5 py-1.5 text-[11px] text-ink/55">
                        {t.notes}
                      </p>
                    )}
                  </button>
                ))}
                {colTasks.length === 0 && (
                  <p className="rounded-xl border border-dashed border-ink/10 py-8 text-center text-xs text-ink/35">
                    No tasks
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
