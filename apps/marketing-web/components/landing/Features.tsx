import {
  CalendarRange,
  ConciergeBell,
  UtensilsCrossed,
  Sparkles,
  Wallet,
  BarChart3,
  Globe,
  Boxes,
} from "lucide-react";

const features = [
  {
    icon: CalendarRange,
    title: "Reservations & Calendar",
    body: "Drag-and-drop booking calendar, walk-ins, group blocks and availability search with zero double bookings — guaranteed by design.",
  },
  {
    icon: ConciergeBell,
    title: "Front Desk & Folios",
    body: "Check-in in under a minute. Room moves, stay extensions, split folios and instant receipts, all keyboard-friendly.",
  },
  {
    icon: Wallet,
    title: "Payments & Reconciliation",
    body: "Paystack, Flutterwave, bank transfer, POS terminal and cash — automatically matched to folios with a tamper-proof ledger.",
  },
  {
    icon: Sparkles,
    title: "Housekeeping & Maintenance",
    body: "Mobile-first room boards, cleaning tasks, inspections and maintenance tickets that work offline and sync when back online.",
  },
  {
    icon: UtensilsCrossed,
    title: "Restaurant & Bar POS",
    body: "Post restaurant and bar orders straight to the guest's room folio. Settle by cash, card or transfer with shift-close controls.",
  },
  {
    icon: BarChart3,
    title: "Reports & Owner Dashboards",
    body: "Daily flash report, occupancy, ADR, RevPAR, discounts and voids — delivered to the owner's phone every morning.",
  },
  {
    icon: Globe,
    title: "Direct Booking Engine",
    body: "A beautiful booking page for your hotel with instant payment confirmation. Stop paying commission on every guest.",
  },
  {
    icon: Boxes,
    title: "Inventory & Procurement",
    body: "Stock ledgers, reorder alerts, purchase orders and variance reports for stores, kitchen and housekeeping supplies.",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-white py-28 lg:py-36">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-gold-500 uppercase">
            Everything included
          </p>
          <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            One platform for the whole property
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-ink/60">
            From the front desk to the kitchen store, every department works
            from the same live data — no more paper registers and midnight
            spreadsheet reconciliation.
          </p>
        </div>

        <div className="mt-20 grid gap-x-10 gap-y-14 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f) => (
            <div key={f.title} className="group">
              <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700 transition-colors group-hover:bg-brand-800 group-hover:text-white">
                <f.icon className="h-6 w-6" />
              </span>
              <h3 className="mt-6 text-lg font-semibold text-ink">{f.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink/55">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
