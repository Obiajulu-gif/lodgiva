import Link from "next/link";
import { ShieldCheck, Headset, Star, ArrowRight } from "lucide-react";
import { DashboardPreview } from "./DashboardPreview";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-cream pt-36 pb-24 lg:pt-44 lg:pb-32">
      {/* soft background accents */}
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
          <p className="mb-8 inline-flex items-center gap-2 rounded-full border border-brand-200 bg-white px-4 py-1.5 text-xs font-semibold tracking-wide text-brand-700">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
            BUILT FOR NIGERIAN HOSPITALITY
          </p>

          <h1 className="font-display text-5xl leading-[1.08] font-semibold tracking-tight text-ink sm:text-6xl lg:text-7xl">
            Run your hotel with
            <span className="text-brand-700"> effortless control</span>
          </h1>

          <p className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-ink/60 lg:text-xl">
            Reservations, front desk, housekeeping, payments, POS and owner
            reports — all in one elegant platform that keeps working even when
            your internet doesn&apos;t.
          </p>

          <div className="mt-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-2 rounded-full bg-brand-800 px-8 py-4 text-base font-semibold text-white shadow-lg shadow-brand-800/20 transition-all hover:bg-brand-700 hover:shadow-xl"
            >
              Try the live demo
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="#pricing"
              className="inline-flex items-center gap-2 rounded-full border border-ink/10 bg-white px-8 py-4 text-base font-semibold text-ink transition-all hover:border-brand-300 hover:text-brand-700"
            >
              View pricing
            </a>
          </div>

          <div className="mt-14 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-sm text-ink/60">
            <span className="flex items-center gap-2">
              <Headset className="h-4 w-4 text-brand-600" />
              24/7 local support in Nigeria
            </span>
            <span className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-brand-600" />
              Fraud-proof financial ledger
            </span>
            <span className="flex items-center gap-2">
              <Star className="h-4 w-4 text-gold-500" />
              Rated 4.9/5 by hoteliers
            </span>
          </div>
        </div>

        <div className="mt-20 lg:mt-24">
          <DashboardPreview />
        </div>
      </div>
    </section>
  );
}
