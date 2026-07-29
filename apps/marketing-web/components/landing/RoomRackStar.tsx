"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * THE STAR OF THE SHOW — a live room rack.
 *
 * Why this and not a generic 3D flourish: the rack is how a general manager
 * actually holds the property in their head. Every morning they ask the same
 * three questions — who is in, what is ready to sell, what needs cleaning.
 * The hook is "this is your hotel, right now", so the graphic is the product
 * surface rather than a decoration of it.
 *
 * It animates once on entry (rooms turn over, an arrival checks in) and then
 * settles. Motion is capped, never loops aggressively, and is fully disabled
 * under prefers-reduced-motion.
 */

type State = "occupied" | "clean" | "dirty" | "ooo";

interface Tile {
  number: string;
  state: State;
  /** The state it flips to during the reveal, if any. */
  becomes?: State;
  guest?: string;
}

const FLOORS: Tile[][] = [
  [
    { number: "101", state: "occupied", guest: "A. Okonkwo" },
    { number: "102", state: "dirty", becomes: "clean" },
    { number: "103", state: "occupied", guest: "T. Bakare" },
    { number: "104", state: "clean" },
    { number: "105", state: "occupied", guest: "I. Musa" },
    { number: "106", state: "dirty", becomes: "clean" },
  ],
  [
    { number: "201", state: "occupied", guest: "C. Eze" },
    { number: "202", state: "clean", becomes: "occupied", guest: "F. Adeyemi" },
    { number: "203", state: "ooo" },
    { number: "204", state: "occupied", guest: "E. Nwosu" },
    { number: "205", state: "dirty" },
    { number: "206", state: "occupied", guest: "Z. Bello" },
  ],
  [
    { number: "301", state: "clean" },
    { number: "302", state: "occupied", guest: "N. Chukwu" },
    { number: "303", state: "occupied", guest: "Y. Abdullahi" },
    { number: "304", state: "dirty" },
    { number: "305", state: "clean" },
    { number: "306", state: "occupied", guest: "B. Okafor" },
  ],
];

const SURFACE: Record<State, string> = {
  // Occupied is the brand's darkest surface: the rack should read as "sold"
  // at a glance, the way a paper rack reads as filled.
  occupied: "bg-brand-800 text-white border-brand-800",
  clean: "bg-brand-50 text-brand-800 border-brand-200",
  dirty: "bg-gold-100 text-gold-600 border-gold-200",
  ooo: "bg-ink/5 text-ink/35 border-ink/10",
};

const DOT: Record<State, string> = {
  occupied: "bg-gold-300",
  clean: "bg-brand-400",
  dirty: "bg-gold-500",
  ooo: "bg-ink/25",
};

const LABEL: Record<State, string> = {
  occupied: "Occupied",
  clean: "Ready to sell",
  dirty: "Needs cleaning",
  ooo: "Out of order",
};

export function RoomRackStar() {
  const ref = useRef<HTMLDivElement>(null);
  // The Star renders VISIBLE by default. Its entrance is an enhancement: if
  // JavaScript, IntersectionObserver or compositing is unavailable, the rack
  // is still fully readable rather than stuck at opacity 0.
  const [revealed, setRevealed] = useState(true);
  const [flipped, setFlipped] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const startFlip = (delay: number) => window.setTimeout(() => setFlipped(true), delay);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || typeof IntersectionObserver === "undefined") {
      // Show the settled end state without animating into it.
      setFlipped(true);
      return;
    }

    // Above the fold: skip the entrance (it would flash after hydration) and
    // just let the hotel "move" shortly after load.
    if (el.getBoundingClientRect().top < window.innerHeight * 0.9) {
      const t = startFlip(1400);
      return () => window.clearTimeout(t);
    }

    setRevealed(false);
    let flipTimer = 0;
    let failsafe = 0;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setRevealed(true);
        // Let the grid land before anything changes state, so the flip reads
        // as the hotel moving rather than as a loading artefact.
        flipTimer = startFlip(1100);
        io.disconnect();
        window.clearTimeout(failsafe);
      },
      { threshold: 0.2 }
    );
    io.observe(el);
    failsafe = window.setTimeout(() => {
      setRevealed(true);
      flipTimer = startFlip(600);
      io.disconnect();
    }, 2000);

    return () => {
      io.disconnect();
      window.clearTimeout(flipTimer);
      window.clearTimeout(failsafe);
    };
  }, []);

  const tiles = useMemo(() => FLOORS.flat(), []);
  const current = (t: Tile): State => (flipped && t.becomes ? t.becomes : t.state);

  const sold = tiles.filter((t) => current(t) === "occupied").length;
  const sellable = tiles.filter((t) => current(t) === "clean").length;
  const dirty = tiles.filter((t) => current(t) === "dirty").length;
  const occupancy = Math.round((sold / tiles.length) * 100);

  return (
    <div ref={ref} className="relative mx-auto max-w-5xl">
      <div className="absolute inset-x-10 -bottom-8 h-24 rounded-panel bg-brand-900/10 blur-2xl" />

      <div className="lift-lg relative overflow-hidden rounded-panel border border-ink/8 bg-white">
        {/* Chrome — the familiar app frame keeps the Survivor brain oriented:
            this is software, not an illustration. */}
        <div className="flex items-center gap-2 border-b border-ink/6 bg-cream px-5 py-3.5">
          <span className="h-2.5 w-2.5 rounded-full bg-ink/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink/10" />
          <span className="h-2.5 w-2.5 rounded-full bg-ink/10" />
          <span className="t-meta ml-3 hidden rounded-chip bg-white px-2.5 py-1 text-[11px] sm:block">
            app.lodgiva.com — Grand Palm Hotel, Lagos
          </span>
          <span className="ml-auto flex items-center gap-1.5 rounded-chip bg-brand-50 px-2.5 py-1 text-[11px] font-semibold text-brand-700">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand-500" />
            </span>
            Live
          </span>
        </div>

        <div className="p-5 sm:p-7">
          {/* Three numbers, not twelve: the GM's actual morning question. */}
          <div className="mb-6 grid grid-cols-3 gap-3 sm:gap-5">
            {[
              { value: `${occupancy}%`, label: "Occupancy tonight", sub: `${sold} of ${tiles.length} sold` },
              { value: String(sellable), label: "Ready to sell", sub: "inspected & clean" },
              { value: String(dirty), label: "Needs cleaning", sub: "queued to housekeeping" },
            ].map((k) => (
              <div key={k.label} className="rounded-card border border-ink/6 bg-cream/60 p-3.5 sm:p-4">
                <p
                  className="font-display text-2xl leading-none font-semibold tabular-nums sm:text-3xl"
                  style={{ transition: "opacity 400ms ease" }}
                >
                  {k.value}
                </p>
                <p className="t-body mt-2 text-[11px] font-medium sm:text-xs">{k.label}</p>
                <p className="t-meta mt-0.5 text-[10px] sm:text-[11px]">{k.sub}</p>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {FLOORS.map((floor, fi) => (
              <div key={fi} className="flex items-center gap-3">
                <span className="t-meta w-8 shrink-0 text-[10px] font-semibold tracking-wide">
                  F{fi + 1}
                </span>
                {/* Six tiles across is unreadable at 375px — the room number
                    and status need real width, so phones get three. */}
                <div className="grid flex-1 grid-cols-3 gap-2 sm:grid-cols-6 sm:gap-2.5">
                  {floor.map((t, ti) => {
                    const state = current(t);
                    const isArrival = flipped && t.becomes === "occupied";
                    return (
                      <div
                        key={t.number}
                        className={`relative rounded-control border px-1.5 py-2.5 text-center sm:py-3 ${SURFACE[state]}`}
                        style={{
                          transition:
                            "background-color 700ms cubic-bezier(0.22,1,0.36,1), color 700ms ease, border-color 700ms ease, opacity 520ms ease, transform 520ms cubic-bezier(0.22,1,0.36,1)",
                          transitionDelay: revealed ? `${(fi * 6 + ti) * 28}ms` : "0ms",
                          opacity: revealed ? 1 : 0,
                          transform: revealed ? "none" : "translateY(10px) scale(0.96)",
                        }}
                        title={`${t.number} — ${LABEL[state]}`}
                      >
                        <span
                          className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${DOT[state]}`}
                        />
                        <span className="block text-[13px] font-semibold tabular-nums sm:text-sm">
                          {t.number}
                        </span>
                        <span className="mt-0.5 block truncate text-[9px] opacity-70 sm:text-[10px]">
                          {state === "occupied" ? (t.guest ?? "In house") : LABEL[state]}
                        </span>
                        {isArrival && (
                          <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-chip bg-gold-400 px-1.5 py-0.5 text-[8px] font-bold whitespace-nowrap text-brand-950">
                            CHECKED IN
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink/6 pt-4">
            {(["occupied", "clean", "dirty", "ooo"] as State[]).map((s) => (
              <span key={s} className="t-secondary flex items-center gap-1.5 text-[11px]">
                <span className={`h-2 w-2 rounded-full ${DOT[s]}`} />
                {LABEL[s]}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
