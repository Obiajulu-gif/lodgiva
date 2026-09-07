"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { BadgeCheck, Building2 } from "lucide-react";
import { Logo } from "@/components/landing/Logo";
import { useAuth } from "@/components/providers";
import { ApiError, api, authPost } from "@/lib/api/client";
import type { LoginResult, Session } from "@/lib/api/types";

const inputClass =
  "mt-2 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const buttonClass =
  "w-full rounded-full bg-brand-800 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60";

/** Matches the backend rule, and is stated up front rather than on rejection. */
const MIN_PASSWORD = 10;

/**
 * The property code is a short operational label that appears on reports and
 * room-rack exports. Deriving it from the hotel name is one less thing for an
 * owner to invent during signup, while staying editable for the ones who
 * already have a code their staff use.
 */
function deriveCode(propertyName: string): string {
  const words = propertyName
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  // A single word gives no initials worth reading, so take a prefix instead.
  const base =
    words.length === 1
      ? words[0].slice(0, 6)
      : words.map((word) => word[0]).join("");
  return base.slice(0, 12);
}

const TIMEZONES = [
  "Africa/Lagos",
  "Africa/Accra",
  "Africa/Abidjan",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "Africa/Cairo",
  "Europe/London",
  "UTC",
];

export default function SignupPage() {
  const router = useRouter();
  const { status, completeSignIn } = useAuth();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [hotelName, setHotelName] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [propertyCode, setPropertyCode] = useState("");
  const [codeEdited, setCodeEdited] = useState(false);
  const [timezone, setTimezone] = useState("Africa/Lagos");
  const [error, setError] = useState("");
  const [emailTaken, setEmailTaken] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated") router.replace("/dashboard");
  }, [router, status]);

  // A single-property hotel is the common case, so the property name follows
  // the business name until the owner says otherwise.
  const effectivePropertyName = propertyName.trim() || hotelName.trim();
  const suggestedCode = useMemo(
    () => deriveCode(effectivePropertyName),
    [effectivePropertyName],
  );
  const finalCode = (codeEdited ? propertyCode : suggestedCode)
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "");

  const passwordTooShort = password.length > 0 && password.length < MIN_PASSWORD;
  const canSubmit =
    !busy &&
    fullName.trim().length >= 2 &&
    email.includes("@") &&
    password.length >= MIN_PASSWORD &&
    hotelName.trim().length >= 2 &&
    effectivePropertyName.length >= 2 &&
    finalCode.length >= 2;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guards a double submit: the button is disabled, but Enter in a field
    // still fires the form.
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    setEmailTaken(false);

    const normalisedEmail = email.trim().toLowerCase();
    try {
      // One transaction on the server creates tenant, owner user, owner
      // membership and the first property, so a failure part-way through
      // leaves no half-made account to clean up. businessDate is deliberately
      // omitted: the server derives it from the timezone, and a wrong laptop
      // clock would otherwise start the property on a date only night audit
      // can move.
      await api("/onboarding/tenants", {
        method: "POST",
        body: {
          tenantName: hotelName.trim(),
          ownerEmail: normalisedEmail,
          ownerFullName: fullName.trim(),
          password,
          propertyName: effectivePropertyName,
          propertyCode: finalCode,
          timezone,
        },
      });

      // Sign in through the ordinary login path rather than minting a second
      // kind of token here. A brand-new owner has no second factor yet, so
      // this returns a session; if that ever changes, /login already handles
      // the MFA branches and this hands off to it.
      const result = await authPost<LoginResult>("login", {
        email: normalisedEmail,
        password,
      });
      setPassword("");

      if ("accessToken" in result) {
        await completeSignIn(result as Session);
        router.replace("/dashboard");
        return;
      }
      router.replace("/login");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "EMAIL_IN_USE") {
        setEmailTaken(true);
        setError("An account already exists for that email.");
      } else if (cause instanceof ApiError && cause.status === 429) {
        setError(
          "Too many attempts from this network. Wait a minute and try again.",
        );
      } else if (cause instanceof ApiError) {
        setError(cause.message);
      } else {
        setError(
          "We could not reach Lodgiva. Check your connection and try again.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // Never render the form to someone who already has a session; they are being
  // redirected to the dashboard.
  if (status === "loading" || status === "authenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-cream text-sm text-ink/55">
        Checking your session…
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-cream px-6 py-12">
      <div className="w-full max-w-md">
        <div className="mb-10 flex justify-center">
          <Link href="/" aria-label="Lodgiva home">
            <Logo />
          </Link>
        </div>

        <div className="rounded-3xl border border-ink/6 bg-white p-8 shadow-sm sm:p-10">
          <div className="mb-7 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <Building2 className="h-5 w-5" aria-hidden="true" />
          </div>

          <h1 className="font-display text-2xl font-semibold text-ink">
            Create your hotel account
          </h1>
          <p className="mt-2 text-sm text-ink/55">
            This sets up your property and makes you its owner. Staff accounts
            are invited from Settings once you are in.
          </p>

          {error ? (
            <p
              className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700"
              role="alert"
            >
              {error}
              {emailTaken ? (
                <>
                  {" "}
                  <Link href="/login" className="font-semibold underline">
                    Sign in instead
                  </Link>
                </>
              ) : null}
            </p>
          ) : null}

          <form onSubmit={submit} noValidate>
            <div className="mt-7">
              <label
                htmlFor="fullName"
                className="text-sm font-medium text-ink/80"
              >
                Your full name
              </label>
              <input
                id="fullName"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                autoComplete="name"
                required
                autoFocus
                className={inputClass}
              />
            </div>

            <div className="mt-5">
              <label htmlFor="email" className="text-sm font-medium text-ink/80">
                Work email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                required
                className={inputClass}
              />
            </div>

            <div className="mt-5">
              <label
                htmlFor="password"
                className="text-sm font-medium text-ink/80"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={MIN_PASSWORD}
                required
                aria-describedby="password-hint"
                aria-invalid={passwordTooShort || undefined}
                className={inputClass}
              />
              <p
                id="password-hint"
                className={`mt-2 text-xs ${
                  passwordTooShort ? "text-red-600" : "text-ink/45"
                }`}
              >
                At least {MIN_PASSWORD} characters.
              </p>
            </div>

            <div className="mt-5">
              <label
                htmlFor="hotelName"
                className="text-sm font-medium text-ink/80"
              >
                Hotel or business name
              </label>
              <input
                id="hotelName"
                value={hotelName}
                onChange={(event) => setHotelName(event.target.value)}
                autoComplete="organization"
                required
                className={inputClass}
              />
            </div>

            <div className="mt-5">
              <label
                htmlFor="propertyName"
                className="text-sm font-medium text-ink/80"
              >
                First property{" "}
                <span className="font-normal text-ink/45">
                  (leave blank if the same)
                </span>
              </label>
              <input
                id="propertyName"
                value={propertyName}
                onChange={(event) => setPropertyName(event.target.value)}
                placeholder={hotelName.trim()}
                className={inputClass}
              />
            </div>

            <div className="mt-5 grid grid-cols-2 gap-4">
              <div>
                <label
                  htmlFor="propertyCode"
                  className="text-sm font-medium text-ink/80"
                >
                  Property code
                </label>
                <input
                  id="propertyCode"
                  value={finalCode}
                  onChange={(event) => {
                    setCodeEdited(true);
                    setPropertyCode(event.target.value);
                  }}
                  maxLength={12}
                  required
                  aria-describedby="code-hint"
                  className={`${inputClass} font-mono uppercase`}
                />
                <p id="code-hint" className="mt-2 text-xs text-ink/45">
                  Shown on reports.
                </p>
              </div>
              <div>
                <label
                  htmlFor="timezone"
                  className="text-sm font-medium text-ink/80"
                >
                  Timezone
                </label>
                <select
                  id="timezone"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                  className={inputClass}
                >
                  {TIMEZONES.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-ink/45">
                  Sets your business date.
                </p>
              </div>
            </div>

            <button
              type="submit"
              disabled={!canSubmit}
              className={`${buttonClass} mt-7`}
            >
              {busy ? "Creating your account…" : "Create account"}
            </button>

            <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-ink/45">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
              30-day trial. No card required.
            </p>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-ink/55">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-brand-700">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
