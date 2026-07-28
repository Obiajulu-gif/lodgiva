"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BedDouble,
  CalendarRange,
  Users,
  Sparkles,
  Wallet,
  BarChart3,
  ArrowLeft,
  Menu,
  X,
  Bell,
  UtensilsCrossed,
  Banknote,
  Settings,
} from "lucide-react";

const nav = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/rooms", label: "Room Rack", icon: BedDouble },
  { href: "/dashboard/reservations", label: "Reservations", icon: CalendarRange },
  { href: "/dashboard/guests", label: "Guests", icon: Users },
  { href: "/dashboard/housekeeping", label: "Housekeeping", icon: Sparkles },
  { href: "/dashboard/pos", label: "POS", icon: UtensilsCrossed },
  { href: "/dashboard/payments", label: "Payments", icon: Wallet },
  { href: "/dashboard/cashiering", label: "Cashiering", icon: Banknote },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-950 text-white">
      <div className="flex items-center gap-2.5 px-6 py-6">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-800">
          <svg viewBox="0 0 24 24" fill="none" className="h-4.5 w-4.5">
            <path
              d="M4 20V9.5L12 4l8 5.5V20"
              stroke="#cda95c"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M9.5 20v-5.5a2.5 2.5 0 0 1 5 0V20"
              stroke="#fff"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
        <span className="font-display text-xl font-semibold">Lodgiva</span>
      </div>

      <div className="mx-6 mb-4 rounded-xl bg-white/5 px-4 py-3">
        <p className="text-[11px] text-white/40">PROPERTY</p>
        <p className="mt-0.5 text-sm font-semibold">Grand Palm Hotel, Lagos</p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-4">
        {nav.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${
                active
                  ? "bg-brand-700 text-white"
                  : "text-white/55 hover:bg-white/5 hover:text-white"
              }`}
            >
              <item.icon className="h-4.5 w-4.5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4">
        <Link
          href="/"
          className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-white/50 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4.5 w-4.5" />
          Back to website
        </Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-cream">
      {/* desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block">
        {sidebar}
      </aside>

      {/* mobile sidebar */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72">{sidebar}</aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-ink/5 bg-white/90 px-6 backdrop-blur">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden"
              onClick={() => setOpen(true)}
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="hidden sm:block">
              <p className="text-xs text-ink/45">Business date</p>
              <p className="text-sm font-semibold text-ink">
                Tuesday, 28 July 2026
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden items-center gap-1.5 rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 sm:flex">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500" />
              Online · Synced
            </span>
            <button className="relative" aria-label="Notifications">
              <Bell className="h-5 w-5 text-ink/60" />
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-gold-500 text-[9px] font-bold text-white">
                3
              </span>
            </button>
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-800 text-xs font-bold text-gold-200">
              GM
            </span>
          </div>
        </header>

        <main className="p-6 lg:p-10">{children}</main>
      </div>
    </div>
  );
}
