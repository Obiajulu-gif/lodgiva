"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { Reveal } from "./Reveal";

/**
 * SHOW, DON'T TELL.
 *
 * Every claim above this section is an adjective; this is the evidence. Real
 * screens from the Lodgiva PMS running a Lagos hotel - naira, VAT at 7.5%,
 * Nigerian guests - not mock-ups. A prospect who sees their own currency on
 * an invoice stops wondering whether the product was built for somewhere else.
 *
 * Clicking a screen opens it full size rather than the live app: the staff
 * screens sit behind sign-in, and a card that leads to a login wall reads as
 * broken. The booking engine is public, so its button opens it for real.
 */

// Where the PMS lives. Empty = same origin, which is right when the landing
// page is served through the Lodgiva router (tunnel or Oracle). Set it on a
// standalone deployment - e.g. lodgiva.vercel.app - to the PMS's address.
const PMS = (process.env.NEXT_PUBLIC_PMS_URL ?? "").replace(/\/$/, "");

interface Screen {
  src: string;
  title: string;
  body: string;
  /** Path in the PMS; staff screens go through sign-in first. */
  href: string;
  isPublic?: boolean;
}

const SCREENS: Screen[] = [
  {
    src: "/showcase/tape-chart.jpg",
    title: "Tape chart",
    body: "Every room, every night at a glance. Drag a stay to move rooms or change dates.",
    href: "/lodgiva/tape",
  },
  {
    src: "/showcase/front-desk.jpg",
    title: "Front desk",
    body: "Today's arrivals, departures, in-house guests and the live room board on one screen.",
    href: "/lodgiva",
  },
  {
    src: "/showcase/booking-engine.jpg",
    title: "Direct booking engine",
    body: "Your own commission-free booking page, with live rates in naira, taxes shown up front.",
    href: "/book",
    isPublic: true,
  },
  {
    src: "/showcase/vat-invoice.jpg",
    title: "VAT invoice in naira",
    body: "7.5% VAT on its own line, TIN on the invoice, the total spelled out in naira and kobo.",
    href: "/lodgiva/billing",
  },
  {
    src: "/showcase/reports.jpg",
    title: "Manager flash",
    body: "Occupancy, ADR, RevPAR and the next seven days' pickup, ready before the morning meeting.",
    href: "/lodgiva/reports",
  },
  {
    src: "/showcase/guest-journey.jpg",
    title: "Guest journey",
    body: "Every stay, bill and preference on one profile, with lifetime value in naira.",
    href: "/lodgiva/guests",
  },
];

function liveHref(s: Screen) {
  const target = `${PMS}${s.href}`;
  return s.isPublic ? target : `${PMS}/login?redirect-to=${encodeURIComponent(s.href)}`;
}

export function Showcase() {
  const [open, setOpen] = useState<Screen | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <section id="showcase" className="bg-white py-24 lg:py-28">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <div className="rule-gold mx-auto mb-7 h-px w-24" />
          <p className="text-[11px] font-semibold tracking-[0.18em] text-gold-600 uppercase">
            See it in action
          </p>
          <h2 className="t-primary mt-4 font-display text-4xl font-semibold text-balance sm:text-5xl">
            Real screens, real naira
          </h2>
          <p className="t-secondary mt-5 text-lg leading-relaxed text-balance">
            Not mock-ups: this is Lodgiva running a Lagos hotel. Click any
            screen to see it full size.
          </p>
        </Reveal>

        <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {SCREENS.map((s, i) => (
            <Reveal key={s.src} delay={(i % 3) * 70}>
              <button
                type="button"
                onClick={() => setOpen(s)}
                className="card-hover group block h-full w-full overflow-hidden rounded-card border border-ink/7 bg-white text-left hover:border-brand-200 hover:shadow-[0_1px_2px_rgba(6,31,23,0.05),0_18px_40px_-18px_rgba(6,31,23,0.22)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                aria-label={`View ${s.title} full size`}
              >
                <div className="aspect-[16/10] overflow-hidden border-b border-ink/7 bg-cream">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.src}
                    alt={`${s.title} screen in the Lodgiva PMS`}
                    width={1440}
                    height={900}
                    loading="lazy"
                    decoding="async"
                    className="h-full w-full object-cover object-top transition-transform duration-500 group-hover:scale-[1.02]"
                  />
                </div>
                <div className="p-6">
                  <h3 className="t-primary text-[17px] font-semibold">{s.title}</h3>
                  <p className="t-secondary mt-2 text-[15px] leading-relaxed">{s.body}</p>
                </div>
              </button>
            </Reveal>
          ))}
        </div>
      </div>

      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        onClick={(e) => {
          if (e.target === e.currentTarget) setOpen(null); // backdrop click
        }}
        className="m-auto w-[min(1200px,94vw)] max-w-none rounded-card bg-white p-0 shadow-2xl backdrop:bg-ink/60 backdrop:backdrop-blur-sm"
        aria-label={open ? `${open.title} full size` : undefined}
      >
        {open && (
          <div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={open.src}
              alt={`${open.title} screen in the Lodgiva PMS`}
              width={1440}
              height={900}
              className="block h-auto max-h-[78vh] w-full object-contain object-top"
            />
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-ink/7 px-6 py-4">
              <div>
                <p className="t-primary font-semibold">{open.title}</p>
                <p className="t-secondary text-sm">{open.body}</p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={liveHref(open)}
                  className="press inline-flex items-center gap-1.5 rounded-control bg-brand-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  {open.isPublic ? "Open it live" : "Sign in to open it"}
                  <ArrowUpRight className="h-4 w-4" />
                </a>
                <button
                  type="button"
                  onClick={() => setOpen(null)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-control border border-ink/10 text-ink hover:border-brand-300"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}
      </dialog>
    </section>
  );
}
