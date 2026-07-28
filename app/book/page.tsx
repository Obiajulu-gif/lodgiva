"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { BedDouble, Users, Check, ShieldCheck, ArrowRight } from "lucide-react";
import { Logo } from "@/components/landing/Logo";
import { formatNaira } from "@/lib/data";

const roomTypes = [
  {
    code: "STD",
    name: "Standard Room",
    rate: 35000,
    occupancy: 2,
    perks: ["Queen bed", "Smart TV & Wi-Fi", "Breakfast included"],
  },
  {
    code: "DLX",
    name: "Deluxe Room",
    rate: 46500,
    occupancy: 2,
    perks: ["King bed", "City view", "Breakfast included", "Work desk"],
  },
  {
    code: "EXE",
    name: "Executive Room",
    rate: 62000,
    occupancy: 3,
    perks: ["King bed + sofa", "Lounge access", "Late checkout", "Minibar"],
  },
  {
    code: "SUT",
    name: "Palm Suite",
    rate: 95000,
    occupancy: 4,
    perks: ["Separate living room", "Ocean view", "Airport pickup", "Butler service"],
  },
];

const VAT_BP = 750; // 7.5%
const SERVICE_BP = 500; // 5%

export default function BookPage() {
  const [checkIn, setCheckIn] = useState("2026-08-05");
  const [checkOut, setCheckOut] = useState("2026-08-07");
  const [selected, setSelected] = useState("DLX");
  const [submitted, setSubmitted] = useState(false);

  const nights = useMemo(() => {
    const a = new Date(checkIn).getTime();
    const b = new Date(checkOut).getTime();
    const n = Math.round((b - a) / 86400000);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }, [checkIn, checkOut]);

  const room = roomTypes.find((r) => r.code === selected)!;
  const subtotal = room.rate * nights;
  const service = Math.round((subtotal * SERVICE_BP) / 10000);
  const vat = Math.round(((subtotal + service) * VAT_BP) / 10000);
  const total = subtotal + service + vat;

  return (
    <main className="min-h-screen bg-cream">
      <header className="border-b border-ink/5 bg-white">
        <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-6">
          <Link href="/">
            <Logo />
          </Link>
          <span className="text-sm text-ink/50">
            Direct booking · Grand Palm Hotel, Lagos
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-14">
        <h1 className="font-display text-4xl font-semibold text-ink">
          Book your stay
        </h1>
        <p className="mt-2 text-ink/55">
          Best rate guaranteed — no booking-site commission, instant
          confirmation.
        </p>

        <div className="mt-10 grid gap-10 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            {/* dates */}
            <div className="flex flex-wrap gap-5 rounded-2xl border border-ink/5 bg-white p-6 shadow-sm">
              <div>
                <label className="text-xs font-semibold text-ink/60">
                  CHECK-IN
                </label>
                <input
                  type="date"
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                  className="mt-2 block rounded-xl border border-ink/10 px-4 py-2.5 text-sm outline-none focus:border-brand-500"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-ink/60">
                  CHECK-OUT
                </label>
                <input
                  type="date"
                  value={checkOut}
                  onChange={(e) => setCheckOut(e.target.value)}
                  className="mt-2 block rounded-xl border border-ink/10 px-4 py-2.5 text-sm outline-none focus:border-brand-500"
                />
              </div>
              <div className="flex items-end pb-1 text-sm font-semibold text-brand-700">
                {nights} night{nights > 1 ? "s" : ""}
              </div>
            </div>

            {/* room selection */}
            <div className="space-y-4">
              {roomTypes.map((r) => (
                <button
                  key={r.code}
                  onClick={() => setSelected(r.code)}
                  className={`flex w-full flex-wrap items-center justify-between gap-4 rounded-2xl border-2 bg-white p-6 text-left transition-all ${
                    selected === r.code
                      ? "border-brand-600 shadow-md"
                      : "border-transparent shadow-sm hover:border-brand-200"
                  }`}
                >
                  <div className="flex items-center gap-5">
                    <span
                      className={`flex h-14 w-14 items-center justify-center rounded-2xl ${
                        selected === r.code
                          ? "bg-brand-800 text-gold-200"
                          : "bg-brand-50 text-brand-700"
                      }`}
                    >
                      <BedDouble className="h-7 w-7" />
                    </span>
                    <div>
                      <p className="font-display text-xl font-semibold text-ink">
                        {r.name}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink/50">
                        <Users className="h-3.5 w-3.5" /> Sleeps {r.occupancy}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                        {r.perks.map((p) => (
                          <span
                            key={p}
                            className="flex items-center gap-1 text-xs text-ink/55"
                          >
                            <Check className="h-3 w-3 text-brand-600" />
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-display text-2xl font-semibold text-ink">
                      {formatNaira(r.rate)}
                    </p>
                    <p className="text-xs text-ink/45">per night</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* summary */}
          <aside className="h-fit rounded-2xl border border-ink/5 bg-white p-7 shadow-sm lg:sticky lg:top-8">
            <h2 className="font-display text-xl font-semibold text-ink">
              Your stay
            </h2>
            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink/55">{room.name}</dt>
                <dd className="text-ink/80">
                  {formatNaira(room.rate)} × {nights}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink/55">Subtotal</dt>
                <dd className="font-medium text-ink">{formatNaira(subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink/55">Service charge (5%)</dt>
                <dd className="text-ink/80">{formatNaira(service)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink/55">VAT (7.5%)</dt>
                <dd className="text-ink/80">{formatNaira(vat)}</dd>
              </div>
              <div className="flex justify-between border-t border-ink/10 pt-3">
                <dt className="font-semibold text-ink">Total</dt>
                <dd className="font-display text-xl font-semibold text-brand-700">
                  {formatNaira(total)}
                </dd>
              </div>
            </dl>

            {submitted ? (
              <div className="mt-7 rounded-xl bg-brand-50 p-5 text-center">
                <p className="font-semibold text-brand-800">
                  Reservation held! 🎉
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink/60">
                  In the full platform you would now be redirected to Paystack
                  to confirm payment. This demo stops here — no payment is
                  taken.
                </p>
              </div>
            ) : (
              <button
                onClick={() => setSubmitted(true)}
                className="group mt-7 flex w-full items-center justify-center gap-2 rounded-full bg-brand-800 py-4 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
              >
                Continue to payment
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}

            <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-[11px] text-ink/40">
              <ShieldCheck className="h-3.5 w-3.5 text-brand-600" />
              Secured by Paystack · Free cancellation up to 48h
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}
