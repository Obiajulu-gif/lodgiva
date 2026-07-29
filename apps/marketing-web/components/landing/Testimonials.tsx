import { Star } from "lucide-react";

const testimonials = [
  {
    quote:
      "Before Lodgiva, we lost money every month to unrecorded discounts and 'ghost' room sales. The audit trail alone paid for the software in the first month.",
    name: "Chief Emeka Obiora",
    role: "Owner, Golden Crest Hotel & Suites",
    city: "Enugu",
    initials: "EO",
  },
  {
    quote:
      "The offline mode is a lifesaver. Even when our internet goes down during check-in rush, front desk keeps working and everything syncs perfectly after.",
    name: "Hauwa Danjuma",
    role: "General Manager, Savannah Court",
    city: "Abuja",
    initials: "HD",
  },
  {
    quote:
      "Bank transfer reconciliation used to take my accountant two full days every week. Lodgiva matches transfers to folios automatically. Two days became twenty minutes.",
    name: "Adebola Ogunleye",
    role: "Finance Director, Palm Riviera Hotels",
    city: "Lagos",
    initials: "AO",
  },
  {
    quote:
      "I get my flash report at 7am every morning — occupancy, revenue, outstanding balances. I finally feel like I can see my hotel from anywhere in the world.",
    name: "Mrs. Ifeoma Azikiwe",
    role: "Owner, The Verandah Boutique Hotel",
    city: "Port Harcourt",
    initials: "IA",
  },
  {
    quote:
      "Our housekeeping team uses old Android phones and it works beautifully. Room turnaround time dropped by 30% in the first quarter.",
    name: "Samuel Etuk",
    role: "Operations Manager, Bayview Apartments",
    city: "Uyo",
    initials: "SE",
  },
  {
    quote:
      "Switching from our old desktop software took one weekend. The Lodgiva team migrated our guest history and trained the whole staff — in person.",
    name: "Fatima Aliyu",
    role: "Managing Director, Emerald Gate Hotel",
    city: "Kano",
    initials: "FA",
  },
];

export function Testimonials() {
  return (
    <section id="testimonials" className="bg-cream py-28 lg:py-36">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-gold-500 uppercase">
            Loved by hoteliers
          </p>
          <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight text-ink sm:text-5xl">
            Trusted from Lagos to Kano
          </h2>
          <p className="mt-6 text-lg leading-relaxed text-ink/60">
            Independent hotels, serviced apartments and growing groups run
            their daily operations on Lodgiva.
          </p>
        </div>

        <div className="mt-20 grid gap-8 md:grid-cols-2 lg:grid-cols-3">
          {testimonials.map((t) => (
            <figure
              key={t.name}
              className="flex flex-col justify-between rounded-card border border-ink/5 bg-white p-8 shadow-sm transition-shadow hover:shadow-md"
            >
              <div>
                <div className="flex gap-1 text-gold-500">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4 w-4 fill-current" />
                  ))}
                </div>
                <blockquote className="mt-5 leading-relaxed text-ink/70">
                  “{t.quote}”
                </blockquote>
              </div>
              <figcaption className="mt-8 flex items-center gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-800 text-sm font-semibold text-gold-200">
                  {t.initials}
                </span>
                <div>
                  <p className="text-sm font-semibold text-ink">{t.name}</p>
                  <p className="text-xs text-ink/50">
                    {t.role} · {t.city}
                  </p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
