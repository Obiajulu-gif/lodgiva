"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

const faqs = [
  {
    q: "What is Lodgiva?",
    a: "Lodgiva is an all-in-one hotel management platform built specifically for Nigerian hotels, guest houses, serviced apartments and hotel groups. It covers reservations, front desk, billing, payments, housekeeping, restaurant POS, inventory and owner reporting in one system.",
  },
  {
    q: "Do I need constant internet for it to work?",
    a: "No. Lodgiva is offline-first. Front desk views, the room rack and housekeeping tasks keep working from a secure local cache when your connection drops, and everything syncs safely when you're back online. Payments are always verified online for your protection.",
  },
  {
    q: "How does payment collection work?",
    a: "Lodgiva supports every way Nigerian hotels collect money: cash with cashier shift balancing, bank transfers with automatic matching, POS terminal references, and card payments or payment links through Paystack and Flutterwave. Every payment is tied to a guest folio and reconciled automatically.",
  },
  {
    q: "Can it stop staff fraud and revenue leakage?",
    a: "Yes — this is one of Lodgiva's core strengths. Financial records are append-only: nothing can be silently edited or deleted. Discounts, voids and refunds require configurable approvals, every action is logged with who/when/why, and the night audit flags anomalies daily.",
  },
  {
    q: "Does it support multiple properties?",
    a: "Yes. The Elite plan gives owners a group dashboard comparing occupancy, ADR, RevPAR and exceptions across all properties, with staff access scoped per property.",
  },
  {
    q: "How does VAT and consumption tax work?",
    a: "Tax rules are fully configurable per property with effective dates — VAT, state consumption tax and service charge, inclusive or exclusive. Invoices always keep the tax rules applied at the time of billing, so historical records never change.",
  },
  {
    q: "How long does setup take?",
    a: "Most hotels go live within one week. We migrate your existing guest and room data, configure your rates and taxes, and train your staff — setup, migration and training are free on every plan.",
  },
  {
    q: "Is my data safe?",
    a: "Your data is encrypted in transit and at rest, backed up continuously, and protected by role-based access control with optional MFA. Each hotel's data is fully isolated. We never store card numbers — card payments are handled by PCI-DSS-compliant gateways.",
  },
  {
    q: "Can I try it before paying?",
    a: "Yes — every plan starts with a 30-day free trial with no card required, and you can explore the live demo dashboard right now without signing up.",
  },
];

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section id="faq" className="bg-cream py-28 lg:py-36">
      <div className="mx-auto max-w-3xl px-6 lg:px-8">
        <div className="text-center">
          <p className="text-sm font-semibold tracking-widest text-gold-500 uppercase">
            Questions, answered
          </p>
          <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Frequently asked questions
          </h2>
        </div>

        <div className="mt-16 space-y-4">
          {faqs.map((f, i) => (
            <div
              key={f.q}
              className="overflow-hidden rounded-2xl border border-ink/6 bg-white"
            >
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center justify-between gap-4 px-7 py-5 text-left"
              >
                <span className="font-semibold text-ink">{f.q}</span>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-brand-600 transition-transform ${
                    open === i ? "rotate-180" : ""
                  }`}
                />
              </button>
              {open === i && (
                <p className="px-7 pb-6 leading-relaxed text-ink/60">{f.a}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
