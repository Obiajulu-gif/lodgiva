import {
  CalendarRange,
  ConciergeBell,
  Globe,
  Wallet,
  UtensilsCrossed,
  BarChart3,
  Sparkles,
  Boxes,
  type LucideIcon,
} from "lucide-react";
import { Reveal } from "./Reveal";

/**
 * CHUNKING (the Rational brain).
 *
 * Eight undifferentiated feature cards force the reader to hold eight items in
 * working memory and judge relevance for each. Grouping them into the three
 * departments a GM already thinks in — front of house, money, back of house —
 * turns one long list into three short ones, and lets a reader skip whole
 * blocks that aren't their problem today.
 */
interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

interface Group {
  eyebrow: string;
  heading: string;
  intro: string;
  features: Feature[];
}

const GROUPS: Group[] = [
  {
    eyebrow: "01 — Front of house",
    heading: "Everything the desk touches",
    intro: "From enquiry to key handover, without a paper register in sight.",
    features: [
      {
        icon: CalendarRange,
        title: "Reservations & calendar",
        body: "Drag-and-drop booking calendar, walk-ins and group blocks. Availability is checked inside the booking transaction, so double bookings are impossible by design.",
      },
      {
        icon: ConciergeBell,
        title: "Front desk & folios",
        body: "Check-in in under a minute. Room moves, stay extensions and split folios — each one leaving an audit trail behind it.",
      },
      {
        icon: Globe,
        title: "Direct booking engine",
        body: "A booking page for your own hotel with instant confirmation, so you stop paying commission on guests who already know your name.",
      },
    ],
  },
  {
    eyebrow: "02 — Money",
    heading: "Every naira accounted for",
    intro:
      "Collection, posting and reconciliation in one ledger that cannot be quietly edited.",
    features: [
      {
        icon: Wallet,
        title: "Payments & reconciliation",
        body: "Paystack, Flutterwave, bank transfer, POS terminal and cash — matched to folios automatically, with cashier shifts that must balance before they close.",
      },
      {
        icon: UtensilsCrossed,
        title: "Restaurant & bar POS",
        body: "Post orders straight to the guest's room folio, or settle to the drawer. Prices come from the menu server-side, never from the till operator.",
      },
      {
        icon: BarChart3,
        title: "Reports & owner dashboards",
        body: "Occupancy, ADR, RevPAR, discounts and voids — plus a tax summary and guest ledger you can export to CSV for your accountant.",
      },
    ],
  },
  {
    eyebrow: "03 — Back of house",
    heading: "The work guests never see",
    intro:
      "The half of the operation that decides whether tonight's rooms are sellable.",
    features: [
      {
        icon: Sparkles,
        title: "Housekeeping & maintenance",
        body: "Mobile-first room boards, inspections and maintenance tickets. Blocking a room takes it out of sale immediately; clearing it sends the room back through cleaning.",
      },
      {
        icon: Boxes,
        title: "Inventory & procurement",
        body: "Stock ledgers, reorder alerts and variance reports for stores, kitchen and housekeeping supplies.",
      },
    ],
  },
];

export function Features() {
  return (
    <section id="features" className="bg-white py-24 lg:py-32">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <div className="rule-gold mx-auto mb-7 h-px w-24" />
          <p className="text-[11px] font-semibold tracking-[0.18em] text-gold-600 uppercase">
            Everything included
          </p>
          <h2 className="t-primary mt-4 font-display text-4xl font-semibold sm:text-5xl">
            One platform, three departments
          </h2>
          <p className="t-secondary mt-5 text-lg leading-relaxed">
            Grouped the way a general manager already thinks about the property
            — so you can skip straight to the part that hurts today.
          </p>
        </Reveal>

        <div className="mt-20 space-y-20">
          {GROUPS.map((group, gi) => (
            <div key={group.eyebrow}>
              <Reveal>
                <div className="flex flex-col gap-2 border-t border-ink/8 pt-6 md:flex-row md:items-end md:justify-between">
                  <div>
                    <p className="text-[11px] font-semibold tracking-[0.16em] text-brand-600 uppercase">
                      {group.eyebrow}
                    </p>
                    <h3 className="t-primary mt-2 font-display text-2xl font-semibold sm:text-3xl">
                      {group.heading}
                    </h3>
                  </div>
                  <p className="t-secondary max-w-md text-sm leading-relaxed md:text-right">
                    {group.intro}
                  </p>
                </div>
              </Reveal>

              <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {group.features.map((f, fi) => (
                  <Reveal key={f.title} delay={fi * 70}>
                    <div className="card-hover group h-full rounded-card border border-ink/7 bg-white p-7 hover:border-brand-200 hover:shadow-[0_1px_2px_rgba(6,31,23,0.05),0_18px_40px_-18px_rgba(6,31,23,0.22)]">
                      {/* VISUAL RHYME: the icon sits in the same rounded
                          square as a room tile on the rack, with the same
                          status dot in the corner. */}
                      <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-control bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-800 group-hover:text-white">
                        <f.icon className="h-6 w-6" />
                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-brand-400 transition-colors group-hover:bg-gold-300" />
                      </span>
                      <h4 className="t-primary mt-6 text-[17px] font-semibold">
                        {f.title}
                      </h4>
                      <p className="t-secondary mt-2.5 text-[15px] leading-relaxed">
                        {f.body}
                      </p>
                    </div>
                  </Reveal>
                ))}
                {/* Balances the final short group without inventing a filler
                    feature. */}
                {gi === GROUPS.length - 1 && (
                  <Reveal delay={140}>
                    <div className="flex h-full flex-col justify-center rounded-card border border-dashed border-ink/12 bg-cream/50 p-7">
                      <p className="t-body text-[15px] font-semibold">
                        Need something specific to your property?
                      </p>
                      <p className="t-secondary mt-2 text-sm leading-relaxed">
                        Group dashboards, channel manager links and custom
                        reports are part of the Elite plan.
                      </p>
                      <a
                        href="#pricing"
                        className="mt-4 text-sm font-semibold text-brand-700 underline-offset-4 hover:underline"
                      >
                        See what&apos;s included →
                      </a>
                    </div>
                  </Reveal>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
