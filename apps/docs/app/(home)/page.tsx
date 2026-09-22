import Link from 'next/link';
import type { Metadata } from 'next';
import {
  ArrowRight,
  BedDouble,
  BookOpen,
  CalendarCheck,
  Receipt,
  Server,
  Settings2,
  Terminal,
} from 'lucide-react';
import { HomeSearch } from '@/components/home-search';
import { appName, siteDescription } from '@/lib/shared';

export const metadata: Metadata = {
  title: `${appName} — hotel management for Nigerian hotels`,
  description: siteDescription,
  alternates: { canonical: '/' },
};

const SECTIONS = [
  {
    icon: BookOpen,
    title: 'Getting started',
    body: 'What Lodgiva is, how a hotel is set up, and your first booking from start to finish.',
    href: '/docs/getting-started',
  },
  {
    icon: CalendarCheck,
    title: 'Front desk',
    body: 'Take bookings, check guests in and out, move rooms, and read the tape chart.',
    href: '/docs/front-desk',
  },
  {
    icon: Receipt,
    title: 'Billing and money',
    body: 'Folios, payments, VAT invoices in naira, the cash drawer and the night audit.',
    href: '/docs/billing',
  },
  {
    icon: BedDouble,
    title: 'Rooms and rates',
    body: 'Room types, rooms, prices, seasons and the guest booking page.',
    href: '/docs/property',
  },
  {
    icon: Settings2,
    title: 'Administration',
    body: 'Staff accounts, what each role may do, and the Nigerian tax settings.',
    href: '/docs/administration',
  },
  {
    icon: Terminal,
    title: 'Developers',
    body: 'How Lodgiva is built, its API, and how to extend it without forking.',
    href: '/docs/developers',
  },
];

const POPULAR = [
  { title: 'Set up your hotel', href: '/docs/getting-started/create-your-hotel' },
  { title: 'Add room types and rooms', href: '/docs/property/room-types' },
  { title: 'Take a booking', href: '/docs/front-desk/create-a-booking' },
  { title: 'Check a guest in', href: '/docs/front-desk/check-in' },
  { title: 'Take a bank transfer payment', href: '/docs/billing/payments' },
  { title: 'Check a guest out', href: '/docs/front-desk/check-out' },
  { title: 'Run the night audit', href: '/docs/billing/night-audit' },
  { title: 'Install Lodgiva on a server', href: '/docs/install/server' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="border-b border-fd-border px-6 py-20 lg:py-24">
        <div className="mx-auto max-w-3xl text-center">
          <h1 className="font-display text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Lodgiva Documentation
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-fd-muted-foreground text-balance">
            Everything you need to set up, run and build with Lodgiva — hotel
            management built for Nigerian hotels.
          </p>

          <div className="mx-auto mt-8 max-w-xl">
            <HomeSearch />
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/docs/getting-started"
              className="inline-flex items-center gap-1.5 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:opacity-90"
            >
              Get started
              <ArrowRight className="size-4" />
            </Link>
            <Link
              href="/docs/developers"
              className="inline-flex items-center gap-1.5 rounded-lg border border-fd-border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              Developer docs
            </Link>
            <a
              href="https://github.com/Obiajulu-gif/lodgiva"
              className="inline-flex items-center gap-1.5 rounded-lg border border-fd-border px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-fd-accent"
            >
              GitHub
            </a>
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SECTIONS.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="group rounded-xl border border-fd-border bg-fd-card p-5 transition-colors hover:border-fd-primary/40"
              >
                <s.icon className="size-5 text-fd-primary" aria-hidden />
                <h2 className="mt-3 font-semibold">{s.title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-fd-muted-foreground">
                  {s.body}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-fd-border px-6 py-16">
        <div className="mx-auto max-w-5xl">
          <h2 className="font-display text-2xl font-semibold">Popular guides</h2>
          <ul className="mt-6 grid gap-x-8 gap-y-1 sm:grid-cols-2">
            {POPULAR.map((p) => (
              <li key={p.href}>
                <Link
                  href={p.href}
                  className="flex items-center justify-between gap-4 border-b border-fd-border/60 py-3 text-sm transition-colors hover:text-fd-primary"
                >
                  {p.title}
                  <ArrowRight className="size-3.5 shrink-0 opacity-40" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-fd-border px-6 py-14">
        <div className="mx-auto flex max-w-5xl flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Server className="mt-0.5 size-5 shrink-0 text-fd-primary" aria-hidden />
            <div>
              <h2 className="font-semibold">Running Lodgiva yourself</h2>
              <p className="mt-1 text-sm text-fd-muted-foreground">
                Lodgiva is open source, under the AGPL-3.0 licence. One command
                installs it on any Ubuntu server.
              </p>
            </div>
          </div>
          <Link
            href="/docs/install/server"
            className="shrink-0 rounded-lg border border-fd-border px-4 py-2 text-sm font-semibold transition-colors hover:bg-fd-accent"
          >
            Installation guide
          </Link>
        </div>
      </section>
    </main>
  );
}
