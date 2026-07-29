import Link from "next/link";
import { ShieldCheck, Headset, WifiOff, ArrowRight } from "lucide-react";
import { RoomRackStar } from "./RoomRackStar";

export function Hero() {
  return (
    <section className="noise relative overflow-hidden bg-cream pt-32 pb-24 lg:pt-40 lg:pb-32">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 right-[-10%] h-[560px] w-[560px] rounded-full bg-brand-100/60 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[-20%] left-[-8%] h-[420px] w-[420px] rounded-full bg-gold-100/70 blur-3xl"
      />

      <div className="relative mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="t-body mb-7 inline-flex items-center gap-2 rounded-chip border border-brand-200 bg-white px-3.5 py-1.5 text-[11px] font-semibold tracking-wide">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            BUILT FOR NIGERIAN HOSPITALITY
          </p>

          {/* ANCHOR type at display size only. The serif carries the promise;
              Inter carries everything the reader has to actually process. */}
          <h1 className="t-primary font-display text-[2.75rem] leading-[1.05] font-semibold sm:text-6xl lg:text-[4.25rem]">
            One screen for the
            <span className="block text-brand-700 italic">whole property</span>
          </h1>

          <p className="t-body mx-auto mt-7 max-w-xl text-lg leading-relaxed">
            Reservations, front desk, housekeeping, POS and payments in one
            system — so your team stops reconciling four registers at midnight.
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/dashboard"
              className="press lift group inline-flex items-center gap-2 rounded-control bg-brand-800 px-7 py-3.5 text-[15px] font-semibold text-white hover:bg-brand-700"
            >
              Start free trial
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              href="/dashboard"
              className="press inline-flex items-center gap-2 rounded-control border border-ink/10 bg-white px-7 py-3.5 text-[15px] font-semibold text-ink hover:border-brand-300 hover:text-brand-700"
            >
              Explore the live demo
            </Link>
          </div>

          <div className="t-secondary mt-9 flex flex-wrap items-center justify-center gap-x-7 gap-y-3 text-[13px]">
            <span className="flex items-center gap-2">
              <WifiOff className="h-4 w-4 text-brand-600" />
              Keeps working when the network drops
            </span>
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand-600" />
              Tamper-proof financial ledger
            </span>
            <span className="flex items-center gap-2">
              <Headset className="h-4 w-4 text-brand-600" />
              Support in Nigeria, 24/7
            </span>
          </div>
        </div>

        {/* STAR OF THE SHOW */}
        <div className="mt-16 lg:mt-20">
          <RoomRackStar />
        </div>

        <p className="t-meta mx-auto mt-8 max-w-lg text-center text-xs">
          The live room rack from the Lodgiva dashboard — occupancy, readiness
          and cleaning status for every room, updating as your team works.
        </p>
      </div>
    </section>
  );
}
