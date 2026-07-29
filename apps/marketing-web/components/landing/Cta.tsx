import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function Cta() {
  return (
    <section id="contact" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-[2.5rem] bg-brand-900 px-8 py-20 text-center sm:px-16 lg:py-28">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 left-1/2 h-72 w-[36rem] -translate-x-1/2 rounded-full bg-gold-400/10 blur-3xl"
          />
          <p className="text-sm font-semibold tracking-widest text-gold-300 uppercase">
            Ready when you are
          </p>
          <h2 className="mx-auto mt-6 max-w-2xl font-display text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Give your hotel the system it deserves
          </h2>
          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-white/60">
            Join hundreds of Nigerian hoteliers running smoother operations,
            cleaner books and happier guests — starting this week.
          </p>
          <div className="mt-12 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-2 rounded-full bg-gold-400 px-8 py-4 text-base font-semibold text-brand-950 transition-all hover:bg-gold-300"
            >
              Start your 30-day free trial
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <a
              href="mailto:hello@lodgiva.com"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 px-8 py-4 text-base font-semibold text-white transition-colors hover:border-gold-300 hover:text-gold-300"
            >
              Schedule a demo
            </a>
          </div>
          <p className="mt-8 text-sm text-white/40">
            No card required · Free setup & training · Cancel anytime
          </p>
        </div>
      </div>
    </section>
  );
}
