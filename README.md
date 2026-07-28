# Lodgiva 🏨

**Modern hotel management software built for Nigerian hotels, serviced apartments and hotel groups.**

Lodgiva covers reservations, front desk, folios, payments & reconciliation, housekeeping, restaurant POS, inventory and owner reporting — designed around the realities of Nigerian hospitality: bank-transfer payments, POS terminals, unreliable connectivity (offline-first), configurable VAT/consumption tax, and fraud-proof append-only financial ledgers.

## What's in this repo

This repository contains the **marketing website + live demo dashboard** built with Next.js:

- `/` — professional landing page (features, pricing in ₦, testimonials, FAQ)
- `/login` — demo sign-in
- `/dashboard` — interactive demo dashboard: overview KPIs (occupancy, ADR, RevPAR), room rack, reservations, guests, housekeeping board, payments & reconciliation, reports

The demo dashboard runs entirely on realistic seed data (`lib/data.ts`) — **no API keys are required to run or deploy it**.

The full platform architecture (multi-tenant NestJS API, PostgreSQL, Redis/BullMQ, Cloudflare R2, offline PWA) is specified in [`docs/technical-specification.md`](docs/technical-specification.md).

## Tech stack

- [Next.js 15](https://nextjs.org/) (App Router) + React 19 + TypeScript
- [Tailwind CSS v4](https://tailwindcss.com/)
- [lucide-react](https://lucide.dev/) icons
- Fonts: Fraunces (display) + Inter (body) via `next/font`

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000.

## Deployment

Deployed on [Vercel](https://vercel.com). Push to `main` (or run `vercel --prod`) to deploy.

## API keys (for the full platform — optional)

The demo needs **no keys**. When you build out the real backend per the spec, you'll need:

| Key | Purpose | How to get it |
|---|---|---|
| `PAYSTACK_SECRET_KEY` | Card payments & payment links | Create an account at [paystack.com](https://paystack.com) → Dashboard → Settings → API Keys & Webhooks. Use test keys (`sk_test_...`) first. |
| `FLUTTERWAVE_SECRET_KEY` | Alternative payment gateway | [flutterwave.com](https://flutterwave.com) → Dashboard → Settings → API Keys. |
| `TERMII_API_KEY` | SMS/WhatsApp notifications to guests | [termii.com](https://termii.com) → sign up → API Settings. |
| `RESEND_API_KEY` (or any email provider) | Booking confirmation emails | [resend.com](https://resend.com) → API Keys. |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | File storage (room photos, invoices) | Cloudflare dashboard → R2 → Manage R2 API Tokens. |
| `DATABASE_URL` | PostgreSQL | Any managed Postgres (Neon, Supabase, Railway). |

Copy `.env.example` to `.env.local` and fill in values. **Never commit `.env` files.**

## Project structure

```
app/
├── page.tsx              # Landing page
├── login/                # Demo sign-in
└── dashboard/            # Demo hotel dashboard
    ├── page.tsx          # Overview (KPIs, charts, active reservations)
    ├── rooms/            # Room rack with status filters
    ├── reservations/     # Reservation list with search & tabs
    ├── guests/           # Guest profiles & lifetime value
    ├── housekeeping/     # Kanban task board
    ├── payments/         # Transactions & reconciliation
    └── reports/          # Revenue summary & exports
components/landing/       # Landing page sections
lib/data.ts               # Demo seed data
docs/                     # Full technical specification + architecture diagrams
```

## License

© Lodgiva. All rights reserved.
