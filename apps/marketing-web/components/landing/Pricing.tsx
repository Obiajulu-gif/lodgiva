"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

/**
 * CHUNKING applied to pricing.
 *
 * A flat list of eight ticks per plan is read as noise — the eye slides off it
 * and the reader falls back to comparing price alone. Grouping each plan's
 * features under the same three headings (Front desk · Money · Operations)
 * does two things: it shortens each list to 2–3 scannable items, and it makes
 * the plans comparable row-by-row across columns rather than as three walls
 * of text.
 */
interface Plan {
  name: string;
  tagline: string;
  monthly: number;
  annual: number;
  rooms: string;
  inherits?: string;
  groups: { label: string; items: string[] }[];
  highlight: boolean;
}

const plans: Plan[] = [
  {
    name: "Starter",
    tagline: "For guest houses and small hotels",
    monthly: 25000,
    annual: 20000,
    rooms: "Up to 15 rooms",
    groups: [
      {
        label: "Front desk",
        items: ["Reservations & booking calendar", "Check-in / check-out", "Guest profiles & history"],
      },
      {
        label: "Money",
        items: ["Cash, transfer & POS payments", "Daily flash report"],
      },
      {
        label: "Operations",
        items: ["Housekeeping room board", "Email support"],
      },
    ],
    highlight: false,
  },
  {
    name: "Professional",
    tagline: "For full-service hotels",
    monthly: 55000,
    annual: 45000,
    rooms: "Up to 60 rooms",
    inherits: "Everything in Starter, plus",
    groups: [
      {
        label: "Front desk",
        items: ["Room moves & stay extensions", "Offline mode when the network drops"],
      },
      {
        label: "Money",
        items: [
          "Paystack & Flutterwave",
          "Automatic bank-transfer matching",
          "Restaurant & bar POS",
          "Cashier shifts & night audit",
        ],
      },
      {
        label: "Operations",
        items: ["Maintenance tickets", "24/7 phone & WhatsApp support"],
      },
    ],
    highlight: true,
  },
  {
    name: "Elite",
    tagline: "For groups and large properties",
    monthly: 120000,
    annual: 95000,
    rooms: "Unlimited rooms & properties",
    inherits: "Everything in Professional, plus",
    groups: [
      {
        label: "Front desk",
        items: ["Direct booking engine", "Multi-property dashboard"],
      },
      {
        label: "Money",
        items: ["Approval workflows & MFA", "Channel manager integration"],
      },
      {
        label: "Operations",
        items: ["Inventory & procurement", "Dedicated account manager", "On-site staff training"],
      },
    ],
    highlight: false,
  },
];

export function Pricing() {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="pricing" className="bg-white py-24 lg:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <div className="rule-gold mx-auto mb-7 h-px w-24" />
          <p className="text-[11px] font-semibold tracking-[0.18em] text-gold-600 uppercase">
            Simple pricing
          </p>
          <h2 className="t-primary mt-4 font-display text-4xl font-semibold sm:text-5xl">
            Pay in naira. No hidden fees.
          </h2>
          <p className="t-secondary mt-5 text-lg leading-relaxed">
            Every plan includes free setup, data migration and staff training.
            Start with a 30-day free trial — no card required.
          </p>

          <div className="mt-9 inline-flex items-center rounded-control border border-ink/10 bg-cream p-1.5">
            <button
              onClick={() => setAnnual(false)}
              className={`press rounded-chip px-5 py-2.5 text-sm font-semibold ${
                !annual ? "bg-brand-800 text-white shadow" : "t-secondary"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`press rounded-chip px-5 py-2.5 text-sm font-semibold ${
                annual ? "bg-brand-800 text-white shadow" : "t-secondary"
              }`}
            >
              Annual
              <span className="ml-2 rounded-chip bg-gold-200 px-1.5 py-0.5 text-[10px] font-bold text-gold-600">
                SAVE 20%
              </span>
            </button>
          </div>
        </div>

        <div className="mt-14 grid gap-7 lg:grid-cols-3">
          {plans.map((p) => {
            const dark = p.highlight;
            return (
              <div
                key={p.name}
                className={`card-hover relative flex flex-col rounded-card p-8 ${
                  dark
                    ? "on-dark lift-lg bg-brand-900 lg:-my-4"
                    : "lift border border-ink/8 bg-white"
                }`}
              >
                {dark && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-chip bg-gold-400 px-3.5 py-1 text-[11px] font-bold tracking-wide text-brand-950">
                    MOST POPULAR
                  </span>
                )}

                <h3 className={`font-display text-2xl font-semibold ${dark ? "text-white" : "t-primary"}`}>
                  {p.name}
                </h3>
                <p className={`mt-1.5 text-sm ${dark ? "text-white/60" : "t-secondary"}`}>
                  {p.tagline}
                </p>

                <div className="mt-7 flex items-baseline gap-2">
                  <span
                    className={`font-display text-[2.75rem] leading-none font-semibold tabular-nums ${
                      dark ? "text-gold-300" : "t-primary"
                    }`}
                  >
                    ₦{(annual ? p.annual : p.monthly).toLocaleString("en-NG")}
                  </span>
                  <span className={`text-sm ${dark ? "text-white/50" : "t-meta"}`}>/month</span>
                </div>
                <p
                  className={`mt-2 text-xs font-semibold ${
                    dark ? "text-white/50" : "text-brand-600"
                  }`}
                >
                  {p.rooms}
                  {annual && " · billed annually"}
                </p>

                {p.inherits && (
                  <p
                    className={`mt-6 border-t pt-5 text-[13px] font-semibold ${
                      dark ? "border-white/10 text-white/70" : "border-ink/8 t-body"
                    }`}
                  >
                    {p.inherits}
                  </p>
                )}

                <div className={`mt-5 flex-1 space-y-5 ${p.inherits ? "" : "border-t border-ink/8 pt-5"}`}>
                  {p.groups.map((g) => (
                    <div key={g.label}>
                      <p
                        className={`text-[10px] font-bold tracking-[0.14em] uppercase ${
                          dark ? "text-white/45" : "t-meta"
                        }`}
                      >
                        {g.label}
                      </p>
                      <ul className="mt-2.5 space-y-2">
                        {g.items.map((item) => (
                          <li key={item} className="flex items-start gap-2.5 text-[14px]">
                            <Check
                              className={`mt-0.5 h-4 w-4 shrink-0 ${
                                dark ? "text-gold-300" : "text-brand-600"
                              }`}
                            />
                            <span className={dark ? "text-white/85" : "t-body"}>{item}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>

                <Link
                  href="/dashboard"
                  className={`press mt-8 rounded-control py-3.5 text-center text-sm font-semibold ${
                    dark
                      ? "bg-gold-400 text-brand-950 hover:bg-gold-300"
                      : "bg-brand-800 text-white hover:bg-brand-700"
                  }`}
                >
                  Start free trial
                </Link>
              </div>
            );
          })}
        </div>

        <p className="t-meta mt-10 text-center text-sm">
          Need a custom deployment or single-tenant hosting?{" "}
          <a href="#contact" className="font-semibold text-brand-700 underline-offset-4 hover:underline">
            Talk to our team
          </a>
        </p>
      </div>
    </section>
  );
}
