"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Banknote,
  BarChart3,
  BedDouble,
  CalendarRange,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  Sparkles,
  Users,
  UtensilsCrossed,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "@/components/providers";

const navigation = [
  {
    href: "/dashboard",
    label: "Overview",
    icon: LayoutDashboard,
    permissions: null,
  },
  {
    href: "/dashboard/rooms",
    label: "Room Rack",
    icon: BedDouble,
    permissions: ["housekeeping.read"],
  },
  {
    href: "/dashboard/reservations",
    label: "Reservations",
    icon: CalendarRange,
    permissions: ["reservation.read"],
  },
  {
    href: "/dashboard/guests",
    label: "Guests",
    icon: Users,
    permissions: ["guest.read"],
  },
  {
    href: "/dashboard/housekeeping",
    label: "Housekeeping",
    icon: Sparkles,
    permissions: ["housekeeping.read"],
  },
  {
    href: "/dashboard/pos",
    label: "POS",
    icon: UtensilsCrossed,
    permissions: ["pos.operate"],
  },
  {
    href: "/dashboard/payments",
    label: "Payments",
    icon: Wallet,
    permissions: ["payment.capture", "report.financial.read"],
  },
  {
    href: "/dashboard/cashiering",
    label: "Cashiering",
    icon: Banknote,
    permissions: [
      "cashier.open_shift",
      "cashier.close_shift",
      "cashier.approve_variance",
    ],
  },
  {
    href: "/dashboard/reports",
    label: "Reports",
    icon: BarChart3,
    permissions: [
      "report.operational.read",
      "report.financial.read",
      "audit.read",
    ],
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    icon: Settings,
    permissions: [
      "settings.property.manage",
      "settings.room.manage",
      "settings.tax.manage",
      "room.block",
      "user.manage",
    ],
  },
] as const;

function displayBusinessDate(value?: string) {
  if (!value) return "Not available";
  const [year, month, day] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-NG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    status,
    me,
    selectedPropertyId,
    setSelectedPropertyId,
    logout,
    error,
    retrySession,
  } = useAuth();
  const [open, setOpen] = useState(false);
  const property =
    me?.properties.find((candidate) => candidate.id === selectedPropertyId) ??
    me?.properties[0];

  useEffect(() => {
    if (status === "anonymous")
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [pathname, router, status]);

  useEffect(() => {
    if (status !== "authenticated" || !me) return;
    const current = navigation.find(
      (item) => item.href !== "/dashboard" && pathname.startsWith(item.href),
    );
    if (
      current?.permissions &&
      !current.permissions.some((permission) =>
        me.permissions.includes(permission),
      )
    )
      router.replace("/dashboard");
  }, [me, pathname, router, status]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream text-sm text-ink/55">
        Restoring your secure workspace…
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream text-sm text-ink/55">
        Redirecting to sign in…
      </div>
    );
  }

  if (!me) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream px-6">
        <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <h1 className="font-display text-2xl font-semibold">
            Workspace unavailable
          </h1>
          <p className="mt-2 text-sm text-ink/55">
            {error || "Your account details could not be loaded."}
          </p>
          <button
            type="button"
            onClick={() => void retrySession()}
            className="mt-6 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  const allowedNavigation = navigation.filter(
    (item) =>
      item.permissions === null ||
      item.permissions.some((permission) =>
        me.permissions.includes(permission),
      ),
  );
  const initials =
    me.user.fullName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "LG";

  const sidebar = (
    <div className="flex h-full flex-col bg-brand-950 text-white">
      <div className="flex items-center gap-2.5 px-6 py-6">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-800"
          aria-hidden="true"
        >
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

      <div className="mx-5 mb-4 rounded-xl bg-white/5 px-4 py-3">
        <label
          htmlFor="property-switcher"
          className="block text-[11px] font-semibold tracking-wide text-white/40"
        >
          PROPERTY
        </label>
        {me.properties.length > 1 ? (
          <select
            id="property-switcher"
            value={property?.id ?? ""}
            onChange={(event) => setSelectedPropertyId(event.target.value)}
            className="mt-1 w-full rounded-lg border border-white/10 bg-brand-900 px-2 py-2 text-sm font-semibold text-white outline-none focus:border-gold-400"
          >
            {me.properties.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="mt-0.5 truncate text-sm font-semibold">
            {property?.name ?? "No property assigned"}
          </p>
        )}
      </div>

      <nav
        aria-label="Dashboard"
        className="flex-1 space-y-1 overflow-y-auto px-4"
      >
        {allowedNavigation.map((item) => {
          const active =
            item.href === "/dashboard"
              ? pathname === item.href
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition-colors ${active ? "bg-brand-700 text-white" : "text-white/55 hover:bg-white/5 hover:text-white"}`}
            >
              <item.icon className="h-4.5 w-4.5" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/8 p-4">
        <button
          type="button"
          onClick={() => void logout()}
          className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4.5 w-4.5" /> Sign out
        </button>
        <Link
          href="/"
          className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-white/45 transition-colors hover:bg-white/5 hover:text-white"
        >
          <ArrowLeft className="h-4.5 w-4.5" /> Back to website
        </Link>
      </div>
    </div>
  );

  if (!property) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-cream px-6">
        <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
          <h1 className="font-display text-2xl font-semibold">
            No property assigned
          </h1>
          <p className="mt-2 text-sm text-ink/55">
            Ask your Lodgiva administrator to assign this account to a property.
          </p>
          <button
            type="button"
            onClick={() => void logout()}
            className="mt-6 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white"
          >
            Sign out
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-cream">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 lg:block">
        {sidebar}
      </aside>
      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 h-full w-full bg-ink/40"
            aria-label="Close navigation"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72">{sidebar}</aside>
        </div>
      ) : null}
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-ink/5 bg-white/90 px-5 backdrop-blur sm:px-6">
          <div className="flex items-center gap-4">
            <button
              type="button"
              className="rounded-lg p-2 hover:bg-ink/5 lg:hidden"
              onClick={() => setOpen((current) => !current)}
              aria-label={open ? "Close navigation" : "Open navigation"}
              aria-expanded={open}
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div>
              <p className="text-[11px] text-ink/45">Business date</p>
              <p className="text-xs font-semibold text-ink sm:text-sm">
                {displayBusinessDate(property.businessDate)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 sm:inline">
              {me.role.replaceAll("_", " ")}
            </span>
            <span
              className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-800 text-xs font-bold text-gold-200"
              title={me.user.fullName}
            >
              {initials}
            </span>
          </div>
        </header>
        <main key={property.id} className="p-5 sm:p-6 lg:p-10">{children}</main>
      </div>
    </div>
  );
}
