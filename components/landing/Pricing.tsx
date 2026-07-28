"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

const plans = [
  {
    name: "Starter",
    tagline: "For guest houses and small hotels",
    monthly: 25000,
    annual: 20000,
    rooms: "Up to 15 rooms",
    features: [
      "Reservations & booking calendar",
      "Front desk check-in / check-out",
      "Guest profiles & history",
      "Payments (cash, transfer, POS)",
      "Housekeeping room board",
      "Daily flash report",
      "Email support",
    ],
    highlight: false,
  },
  {
    name: "Professional",
    tagline: "For full-service hotels",
    monthly: 55000,
    annual: 45000,
    rooms: "Up to 60 rooms",
    features: [
      "Everything in Starter",
      "Paystack & Flutterwave integration",
      "Automatic bank-transfer matching",
      "Restaurant & bar POS",
      "Cashier shifts & night audit",
      "Offline mode (PWA)",
      "Owner dashboards & exports",
      "24/7 phone & WhatsApp support",
    ],
    highlight: true,
  },
  {
    name: "Elite",
    tagline: "For groups and large properties",
    monthly: 120000,
    annual: 95000,
    rooms: "Unlimited rooms & properties",
    features: [
      "Everything in Professional",
      "Multi-property dashboard",
      "Direct booking engine",
      "Inventory & procurement",
      "Approval workflows & MFA",
      "Channel manager integration",
      "Dedicated account manager",
      "On-site staff training",
    ],
    highlight: false,
  },
];

export function Pricing() {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="pricing" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-gold-500 uppercase">
            Simple pricing
          </p>
          <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Pay in naira. No hidden fees.
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-ink/60">
            Every plan includes free setup, data migration and staff training.
            Start with a 30-day free trial — no card required.
          </p>

          <div className="mt-10 inline-flex items-center rounded-full border border-ink/10 bg-cream p-1.5">
            <button
              onClick={() => setAnnual(false)}
              className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-all ${
                !annual ? "bg-brand-800 text-white shadow" : "text-ink/60"
              }`}
            >
              Monthly
            </button>
            <button
              onClick={() => setAnnual(true)}
              className={`rounded-full px-6 py-2.5 text-sm font-semibold transition-all ${
                annual ? "bg-brand-800 text-white shadow" : "text-ink/60"
              }`}
            >
              Annual
              <span className="ml-2 rounded-full bg-gold-200 px-2 py-0.5 text-[10px] font-bold text-gold-600">
                SAVE 20%
              </span>
            </button>
          </div>
        </div>

        <div className="mt-16 grid gap-8 lg:grid-cols-3">
          {plans.map((p) => (
            <div
              key={p.name}
              className={`relative flex flex-col rounded-3xl p-9 ${
                p.highlight
                  ? "bg-brand-900 text-white shadow-2xl shadow-brand-900/25 lg:-my-4 lg:py-13"
                  : "border border-ink/8 bg-white"
              }`}
            >
              {p.highlight && (
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-gold-400 px-4 py-1 text-xs font-bold tracking-wide text-brand-950">
                  MOST POPULAR
                </span>
              )}

              <h3
                className={`font-display text-2xl font-semibold ${
                  p.highlight ? "text-white" : "text-ink"
                }`}
              >
                {p.name}
              </h3>
              <p
                className={`mt-2 text-sm ${
                  p.highlight ? "text-white/60" : "text-ink/50"
                }`}
              >
                {p.tagline}
              </p>

              <div className="mt-8 flex items-baseline gap-2">
                <span
                  className={`font-display text-5xl font-semibold ${
                    p.highlight ? "text-gold-300" : "text-ink"
                  }`}
                >
                  ₦{(annual ? p.annual : p.monthly).toLocaleString("en-NG")}
                </span>
                <span
                  className={`text-sm ${
                    p.highlight ? "text-white/50" : "text-ink/40"
                  }`}
                >
                  /month
                </span>
              </div>
              <p
                className={`mt-2 text-xs font-semibold ${
                  p.highlight ? "text-white/50" : "text-brand-600"
                }`}
              >
                {p.rooms}
                {annual && " · billed annually"}
              </p>

              <ul className="mt-9 flex-1 space-y-4">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm">
                    <Check
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        p.highlight ? "text-gold-300" : "text-brand-600"
                      }`}
                    />
                    <span
                      className={p.highlight ? "text-white/80" : "text-ink/70"}
                    >
                      {f}
                    </span>
                  </li>
                ))}
              </ul>

              <Link
                href="/dashboard"
                className={`mt-10 rounded-full py-3.5 text-center text-sm font-semibold transition-all ${
                  p.highlight
                    ? "bg-gold-400 text-brand-950 hover:bg-gold-300"
                    : "bg-brand-800 text-white hover:bg-brand-700"
                }`}
              >
                Start free trial
              </Link>
            </div>
          ))}
        </div>

        <p className="mt-12 text-center text-sm text-ink/45">
          Need a custom deployment or single-tenant hosting?{" "}
          <a href="#contact" className="font-semibold text-brand-700 underline-offset-4 hover:underline">
            Talk to our team
          </a>
        </p>
      </div>
    </section>
  );
}
