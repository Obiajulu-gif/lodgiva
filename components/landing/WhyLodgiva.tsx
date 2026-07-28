import { WifiOff, ShieldCheck, Banknote, LineChart } from "lucide-react";

const stats = [
  { value: "120+", label: "Properties on Lodgiva" },
  { value: "₦4.2bn", label: "Payments reconciled monthly" },
  { value: "99.9%", label: "Platform uptime" },
  { value: "38%", label: "Average drop in revenue leakage" },
];

const pillars = [
  {
    icon: WifiOff,
    title: "Works offline, syncs later",
    body: "NEPA took the light? Network down? Your front desk and housekeeping keep working from local cache and sync safely the moment you're back online.",
  },
  {
    icon: ShieldCheck,
    title: "Revenue leakage, eliminated",
    body: "Every naira lives in an append-only ledger. Nothing is deleted — only reversed with a reason, an approver and an audit trail. Voids, discounts and refunds always leave a paper trail.",
  },
  {
    icon: Banknote,
    title: "Built for Nigerian payments",
    body: "Bank transfers with automatic matching, POS terminal references, Paystack and Flutterwave webhooks, cashier shifts and end-of-day balancing — the way Nigerian hotels actually collect money.",
  },
  {
    icon: LineChart,
    title: "Owner visibility, every morning",
    body: "A daily flash report on your phone: occupancy, ADR, RevPAR, outstanding balances and anything unusual — before your first cup of tea.",
  },
];

export function WhyLodgiva() {
  return (
    <section id="why" className="bg-brand-900 py-28 text-white lg:py-36">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid gap-16 lg:grid-cols-2 lg:gap-24">
          <div className="lg:sticky lg:top-32 lg:self-start">
            <p className="text-sm font-semibold tracking-widest text-gold-300 uppercase">
              Why hotels choose Lodgiva
            </p>
            <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
              Designed for how hotels really run in Nigeria
            </h2>
            <p className="mt-6 max-w-lg text-lg leading-relaxed text-white/60">
              Most hotel software is built for perfect internet and card-only
              payments. Lodgiva is built for the realities on the ground —
              and it shows in your bottom line.
            </p>

            <dl className="mt-14 grid grid-cols-2 gap-x-8 gap-y-10">
              {stats.map((s) => (
                <div key={s.label}>
                  <dt className="font-display text-4xl font-semibold text-gold-300">
                    {s.value}
                  </dt>
                  <dd className="mt-2 text-sm text-white/55">{s.label}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="space-y-6">
            {pillars.map((p) => (
              <div
                key={p.title}
                className="rounded-3xl border border-white/10 bg-white/[0.04] p-8 transition-colors hover:bg-white/[0.07] lg:p-10"
              >
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gold-400/15 text-gold-300">
                  <p.icon className="h-6 w-6" />
                </span>
                <h3 className="mt-6 font-display text-2xl font-semibold">
                  {p.title}
                </h3>
                <p className="mt-4 leading-relaxed text-white/60">{p.body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
