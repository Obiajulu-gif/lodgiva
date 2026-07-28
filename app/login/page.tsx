"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/landing/Logo";

export default function LoginPage() {
  const router = useRouter();

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-6">
      <div className="w-full max-w-md">
        <div className="mb-10 flex justify-center">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="rounded-3xl border border-ink/6 bg-white p-10 shadow-sm">
          <h1 className="font-display text-2xl font-semibold text-ink">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-ink/55">
            Sign in to your hotel dashboard.
          </p>

          <form
            className="mt-8 space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              router.push("/dashboard");
            }}
          >
            <div>
              <label className="text-sm font-medium text-ink/80">Email</label>
              <input
                type="email"
                placeholder="you@yourhotel.com"
                className="mt-2 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none transition-colors focus:border-brand-500"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-ink/80">
                Password
              </label>
              <input
                type="password"
                placeholder="••••••••"
                className="mt-2 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none transition-colors focus:border-brand-500"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-full bg-brand-800 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700"
            >
              Sign in
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-ink/45">
            This is a demo — any credentials open the demo dashboard.
          </p>
        </div>
        <p className="mt-8 text-center text-sm text-ink/55">
          New to Lodgiva?{" "}
          <Link
            href="/dashboard"
            className="font-semibold text-brand-700 hover:underline"
          >
            Start a free trial
          </Link>
        </p>
      </div>
    </main>
  );
}
