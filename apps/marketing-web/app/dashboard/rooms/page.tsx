"use client";

import { useState } from "react";
import { rooms, type RoomStatus, formatNaira } from "@/lib/data";

const statusMeta: Record<
  RoomStatus,
  { label: string; cls: string; dot: string }
> = {
  VACANT_CLEAN: { label: "Vacant · Clean", cls: "bg-brand-50 border-brand-200 text-brand-800", dot: "bg-brand-400" },
  INSPECTED: { label: "Inspected", cls: "bg-brand-100 border-brand-300 text-brand-900", dot: "bg-brand-600" },
  VACANT_DIRTY: { label: "Vacant · Dirty", cls: "bg-gold-100 border-gold-300 text-gold-600", dot: "bg-gold-500" },
  OCCUPIED_CLEAN: { label: "Occupied", cls: "bg-brand-800 border-brand-800 text-white", dot: "bg-gold-300" },
  OCCUPIED_DIRTY: { label: "Occupied · Dirty", cls: "bg-brand-700 border-brand-700 text-white", dot: "bg-gold-400" },
  OUT_OF_ORDER: { label: "Out of order", cls: "bg-ink/5 border-ink/10 text-ink/40", dot: "bg-ink/30" },
};

const filters: { key: "ALL" | RoomStatus; label: string }[] = [
  { key: "ALL", label: "All rooms" },
  { key: "OCCUPIED_CLEAN", label: "Occupied" },
  { key: "VACANT_CLEAN", label: "Vacant clean" },
  { key: "VACANT_DIRTY", label: "Needs cleaning" },
  { key: "OUT_OF_ORDER", label: "Out of order" },
];

export default function RoomRackPage() {
  const [filter, setFilter] = useState<"ALL" | RoomStatus>("ALL");

  const visible = rooms.filter((r) => {
    if (filter === "ALL") return true;
    if (filter === "OCCUPIED_CLEAN") return r.status.startsWith("OCCUPIED");
    return r.status === filter;
  });

  const floors = [...new Set(visible.map((r) => r.floor))].sort();

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            Room Rack
          </h1>
          <p className="mt-1 text-ink/55">
            Live status of all 50 rooms · click a room for details.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
                filter === f.key
                  ? "bg-brand-800 text-white"
                  : "border border-ink/10 bg-white text-ink/60 hover:border-brand-300"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {floors.map((floor) => (
        <div key={floor}>
          <h2 className="mb-4 text-sm font-semibold tracking-wide text-ink/50">
            FLOOR {floor}
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {visible
              .filter((r) => r.floor === floor)
              .map((r) => {
                const meta = statusMeta[r.status];
                return (
                  <div
                    key={r.id}
                    className={`cursor-pointer rounded-2xl border p-5 transition-transform hover:-translate-y-0.5 ${meta.cls}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-display text-2xl font-semibold">
                        {r.number}
                      </span>
                      <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                    </div>
                    <p className="mt-1 text-xs opacity-75">{r.type}</p>
                    <p className="mt-3 text-[11px] font-semibold tracking-wide uppercase opacity-90">
                      {meta.label}
                    </p>
                    <p className="mt-2 truncate text-xs opacity-75">
                      {r.guest ?? formatNaira(r.rate) + " / night"}
                    </p>
                  </div>
                );
              })}
          </div>
        </div>
      ))}
    </div>
  );
}
