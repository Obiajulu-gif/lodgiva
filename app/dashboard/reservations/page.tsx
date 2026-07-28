"use client";

import { useState } from "react";
import { Search, Plus, X } from "lucide-react";
import { reservations as seedReservations, formatNaira, type Reservation } from "@/lib/data";

const statusStyles: Record<string, string> = {
  CHECKED_IN: "bg-brand-100 text-brand-800",
  CONFIRMED: "bg-blue-50 text-blue-700",
  PENDING_PAYMENT: "bg-gold-100 text-gold-600",
  CHECKED_OUT: "bg-ink/5 text-ink/50",
  CANCELLED: "bg-red-50 text-red-600",
  NO_SHOW: "bg-red-50 text-red-600",
};

const tabs = ["All", "Arrivals", "In-house", "Departures", "Cancelled"];

const roomTypeRates: Record<string, number> = {
  Standard: 35000,
  Deluxe: 46500,
  Executive: 62000,
  Suite: 95000,
};

export default function ReservationsPage() {
  const [tab, setTab] = useState("All");
  const [query, setQuery] = useState("");
  const [reservations, setReservations] = useState<Reservation[]>(seedReservations);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    guest: "",
    roomType: "Deluxe",
    room: "",
    arrival: "2026-07-30",
    departure: "2026-07-31",
  });

  const createReservation = () => {
    if (!form.guest.trim()) return;
    const nights = Math.max(
      1,
      Math.round(
        (new Date(form.departure).getTime() - new Date(form.arrival).getTime()) /
          86400000
      )
    );
    const total = (roomTypeRates[form.roomType] ?? 46500) * nights;
    setReservations((prev) => [
      {
        id: `res_${Date.now()}`,
        code: `LDG-${4830 + prev.length}`,
        guest: form.guest.trim(),
        room: form.room || "—",
        roomType: form.roomType,
        arrival: form.arrival,
        departure: form.departure,
        nights,
        adults: 1,
        status: "CONFIRMED",
        total,
        balance: total,
        source: "Walk-in",
      },
      ...prev,
    ]);
    setShowModal(false);
    setForm({ ...form, guest: "", room: "" });
    setTab("All");
  };

  const filtered = reservations.filter((r) => {
    const q = query.toLowerCase();
    const matchesQuery =
      !q ||
      r.guest.toLowerCase().includes(q) ||
      r.code.toLowerCase().includes(q) ||
      r.room.includes(q);
    const matchesTab =
      tab === "All" ||
      (tab === "Arrivals" && r.status === "CONFIRMED") ||
      (tab === "In-house" && r.status === "CHECKED_IN") ||
      (tab === "Departures" && r.status === "CHECKED_OUT") ||
      (tab === "Cancelled" && ["CANCELLED", "NO_SHOW"].includes(r.status));
    return matchesQuery && matchesTab;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            Reservations
          </h1>
          <p className="mt-1 text-ink/55">
            Search, filter and manage all bookings.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="inline-flex items-center gap-2 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          New reservation
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
                tab === t
                  ? "bg-brand-800 text-white"
                  : "border border-ink/10 bg-white text-ink/60 hover:border-brand-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search guest, code or room…"
            className="w-72 rounded-full border border-ink/10 bg-white py-2.5 pr-4 pl-10 text-sm outline-none transition-colors focus:border-brand-400"
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/60 text-xs text-ink/50">
                <th className="px-6 py-3.5 font-medium">Code</th>
                <th className="px-4 py-3.5 font-medium">Guest</th>
                <th className="px-4 py-3.5 font-medium">Room</th>
                <th className="px-4 py-3.5 font-medium">Dates</th>
                <th className="px-4 py-3.5 font-medium">Nights</th>
                <th className="px-4 py-3.5 font-medium">Source</th>
                <th className="px-4 py-3.5 font-medium">Status</th>
                <th className="px-4 py-3.5 text-right font-medium">Total</th>
                <th className="px-6 py-3.5 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-ink/5 transition-colors hover:bg-cream/40"
                >
                  <td className="px-6 py-4 font-mono text-xs text-brand-700">
                    {r.code}
                  </td>
                  <td className="px-4 py-4 font-medium text-ink">{r.guest}</td>
                  <td className="px-4 py-4 text-ink/60">
                    {r.room} · {r.roomType}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {r.arrival} → {r.departure}
                  </td>
                  <td className="px-4 py-4 text-ink/60">{r.nights}</td>
                  <td className="px-4 py-4 text-ink/60">{r.source}</td>
                  <td className="px-4 py-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-[11px] font-semibold whitespace-nowrap ${statusStyles[r.status]}`}
                    >
                      {r.status.replace("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-right text-ink/80">
                    {formatNaira(r.total)}
                  </td>
                  <td
                    className={`px-6 py-4 text-right font-semibold ${
                      r.balance > 0 ? "text-gold-600" : "text-brand-600"
                    }`}
                  >
                    {r.balance > 0 ? formatNaira(r.balance) : "Paid"}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-6 py-16 text-center text-ink/40">
                    No reservations match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => setShowModal(false)}
          />
          <div className="relative w-full max-w-md rounded-3xl bg-white p-8 shadow-2xl">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold text-ink">
                New reservation
              </h2>
              <button onClick={() => setShowModal(false)} aria-label="Close">
                <X className="h-5 w-5 text-ink/40" />
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-semibold text-ink/60">
                  GUEST NAME
                </label>
                <input
                  value={form.guest}
                  onChange={(e) => setForm({ ...form, guest: e.target.value })}
                  placeholder="e.g. Chinwe Okafor"
                  className="mt-1.5 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none focus:border-brand-500"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-ink/60">
                    ROOM TYPE
                  </label>
                  <select
                    value={form.roomType}
                    onChange={(e) =>
                      setForm({ ...form, roomType: e.target.value })
                    }
                    className="mt-1.5 w-full rounded-xl border border-ink/10 bg-white px-4 py-3 text-sm outline-none focus:border-brand-500"
                  >
                    {Object.keys(roomTypeRates).map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink/60">
                    ROOM (OPTIONAL)
                  </label>
                  <input
                    value={form.room}
                    onChange={(e) => setForm({ ...form, room: e.target.value })}
                    placeholder="e.g. 204"
                    className="mt-1.5 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none focus:border-brand-500"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-ink/60">
                    ARRIVAL
                  </label>
                  <input
                    type="date"
                    value={form.arrival}
                    onChange={(e) =>
                      setForm({ ...form, arrival: e.target.value })
                    }
                    className="mt-1.5 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none focus:border-brand-500"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-ink/60">
                    DEPARTURE
                  </label>
                  <input
                    type="date"
                    value={form.departure}
                    onChange={(e) =>
                      setForm({ ...form, departure: e.target.value })
                    }
                    className="mt-1.5 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none focus:border-brand-500"
                  />
                </div>
              </div>

              <button
                onClick={createReservation}
                disabled={!form.guest.trim()}
                className="mt-2 w-full rounded-full bg-brand-800 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-40"
              >
                Create reservation
              </button>
              <p className="text-center text-[11px] text-ink/40">
                Demo only — the reservation is added to this session, not saved.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
