import Link from "next/link";
import { Logo } from "./Logo";

const columns = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "#pricing" },
      { label: "Live demo", href: "/dashboard" },
      { label: "Booking engine", href: "/book" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About us", href: "#why" },
      { label: "Testimonials", href: "#testimonials" },
      { label: "Careers", href: "#contact" },
      { label: "Contact", href: "#contact" },
    ],
  },
  {
    title: "Support",
    links: [
      { label: "Help centre", href: "#faq" },
      { label: "FAQ", href: "#faq" },
      { label: "WhatsApp support", href: "#contact" },
      { label: "System status", href: "#contact" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-ink/5 bg-cream">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-8">
        <div className="grid gap-14 lg:grid-cols-5">
          <div className="lg:col-span-2">
            <Logo />
            <p className="mt-6 max-w-sm leading-relaxed text-ink/55">
              The all-in-one hotel management platform built for Nigerian
              hospitality. Lagos · Abuja · Port Harcourt.
            </p>
            <p className="mt-6 text-sm text-ink/45">
              hello@lodgiva.com
              <br />
              +234 (0) 700 LODGIVA
            </p>
          </div>

          {columns.map((c) => (
            <div key={c.title}>
              <h4 className="text-sm font-semibold tracking-wide text-ink">
                {c.title}
              </h4>
              <ul className="mt-5 space-y-3.5">
                {c.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-ink/55 transition-colors hover:text-brand-700"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-16 flex flex-col items-center justify-between gap-4 border-t border-ink/5 pt-8 sm:flex-row">
          <p className="text-xs text-ink/40">
            © {new Date().getFullYear()} Lodgiva Technologies Ltd. All rights
            reserved.
          </p>
          <p className="text-xs text-ink/40">
            Proudly built for Nigerian hospitality 🇳🇬
          </p>
        </div>
      </div>
    </footer>
  );
}
