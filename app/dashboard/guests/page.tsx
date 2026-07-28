"use client";

import { useState } from "react";
import { Search, Crown } from "lucide-react";
import { guests, formatNaira } from "@/lib/data";

export default function GuestsPage() {
  const [query, setQuery] = useState("");

  const filtered = guests.filter((g) => {
    const q = query.toLowerCase();
    return (
      !q ||
      g.name.toLowerCase().includes(q) ||
      g.email.toLowerCase().includes(q) ||
      g.phone.includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            Guests
          </h1>
          <p className="mt-1 text-ink/55">
            Guest profiles, history and lifetime value.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-ink/35" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, email or phone…"
            className="w-72 rounded-full border border-ink/10 bg-white py-2.5 pr-4 pl-10 text-sm outline-none transition-colors focus:border-brand-400"
          />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {filtered.map((g) => (
          <div
            key={g.id}
            className="rounded-2xl border border-ink/5 bg-white p-6 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-800 font-semibold text-gold-200">
                {g.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")}
              </span>
              {g.vip && (
                <span className="flex items-center gap-1 rounded-full bg-gold-100 px-2.5 py-1 text-[10px] font-bold text-gold-600">
                  <Crown className="h-3 w-3" /> VIP
                </span>
              )}
            </div>
            <h3 className="mt-4 font-semibold text-ink">{g.name}</h3>
            <p className="mt-0.5 text-xs text-ink/50">{g.email}</p>
            <p className="text-xs text-ink/50">{g.phone}</p>

            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-ink/5 pt-4 text-xs">
              <div>
                <p className="text-ink/45">Stays</p>
                <p className="mt-0.5 font-semibold text-ink">{g.stays}</p>
              </div>
              <div>
                <p className="text-ink/45">Lifetime spend</p>
                <p className="mt-0.5 font-semibold text-brand-700">
                  {formatNaira(g.lifetimeSpend)}
                </p>
              </div>
              <div>
                <p className="text-ink/45">Nationality</p>
                <p className="mt-0.5 font-semibold text-ink">{g.nationality}</p>
              </div>
              <div>
                <p className="text-ink/45">Last stay</p>
                <p className="mt-0.5 font-semibold text-ink">{g.lastStay}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
