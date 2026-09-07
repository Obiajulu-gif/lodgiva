"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, type FormEvent, useEffect, useState } from "react";
import { ArrowLeft, CheckCircle2, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/landing/Logo";
import { useAuth } from "@/components/providers";
import { authPost, getSession, setSession } from "@/lib/api/client";
import type {
  ActivatedSession,
  LoginResult,
  MfaSetup,
  Session,
} from "@/lib/api/types";

type Step = "password" | "mfa" | "enrol" | "recovery";

const inputClass =
  "mt-2 w-full rounded-xl border border-ink/10 px-4 py-3 text-sm outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-100";
const buttonClass =
  "w-full rounded-full bg-brand-800 py-3.5 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Where to land after signing in. The middleware puts the page the visitor was
 * refused on into `next`, so they resume where they were interrupted instead
 * of always being dropped at the overview.
 *
 * Only same-origin paths are honoured: a bare "/" prefix still permits
 * "//evil.example" (protocol-relative) and "/\evil.example", which browsers
 * treat as absolute. An open redirect on a login page is how a credible
 * phishing link gets built.
 */
function safeNext(raw: string | null): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
    return "/dashboard";
  }
  return raw;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = safeNext(searchParams.get("next"));
  const { status, completeSignIn } = useAuth();
  const [step, setStep] = useState<Step>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === "authenticated" && step !== "recovery")
      router.replace(destination);
  }, [destination, router, status, step]);

  async function finishSignIn(nextSession: Session) {
    await completeSignIn(nextSession);
    router.replace(destination);
  }

  function showFailure(cause: unknown, fallback: string) {
    setError(cause instanceof Error ? cause.message : fallback);
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authPost<LoginResult>("login", {
        email: email.trim().toLowerCase(),
        password,
      });
      setPassword("");
      if ("status" in result && result.status === "MFA_REQUIRED") {
        setChallengeToken(result.mfaToken);
        setStep("mfa");
      } else if (
        "status" in result &&
        result.status === "MFA_ENROLMENT_REQUIRED"
      ) {
        setSetupToken(result.setupToken);
        const enrolment = await authPost<MfaSetup>("mfa/enrol/setup", {
          setupToken: result.setupToken,
        });
        setSetup(enrolment);
        setStep("enrol");
      } else {
        await finishSignIn(result as Session);
      }
    } catch (cause) {
      showFailure(cause, "Sign in failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const nextSession = await authPost<Session>("mfa/verify", {
        mfaToken: challengeToken,
        code: code.trim(),
      });
      await finishSignIn(nextSession);
    } catch (cause) {
      showFailure(cause, "The verification code could not be checked.");
    } finally {
      setBusy(false);
    }
  }

  async function activateMfa(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await authPost<ActivatedSession>("mfa/enrol/activate", {
        setupToken,
        code: code.trim(),
      });
      setSession(result);
      setRecoveryCodes(result.recoveryCodes);
      setStep("recovery");
    } catch (cause) {
      showFailure(cause, "Two-factor authentication could not be activated.");
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    setSession(null);
    setStep("password");
    setPassword("");
    setCode("");
    setChallengeToken("");
    setSetupToken("");
    setSetup(null);
    setRecoveryCodes([]);
    setError("");
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
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>

          {step === "password" ? (
            <form onSubmit={submitPassword}>
              <h1 className="font-display text-2xl font-semibold text-ink">
                Welcome back
              </h1>
              <p className="mt-2 text-sm text-ink/55">
                Sign in to your Lodgiva workspace.
              </p>
              {error ? (
                <p
                  className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="mt-7">
                <label
                  htmlFor="email"
                  className="text-sm font-medium text-ink/80"
                >
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
                  autoFocus
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
                  autoComplete="current-password"
                  required
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className={`${buttonClass} mt-7`}
              >
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <p className="mt-5 text-center text-xs leading-relaxed text-ink/45">
                Use the work account issued by your property administrator.
              </p>
            </form>
          ) : null}

          {step === "mfa" ? (
            <form onSubmit={submitMfa}>
              <h1 className="font-display text-2xl font-semibold text-ink">
                Verify it&apos;s you
              </h1>
              <p className="mt-2 text-sm text-ink/55">
                Enter an authenticator code or one of your recovery codes.
              </p>
              {error ? (
                <p
                  className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <div className="mt-7">
                <label
                  htmlFor="mfa-code"
                  className="text-sm font-medium text-ink/80"
                >
                  Verification code
                </label>
                <input
                  id="mfa-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className={`${buttonClass} mt-7`}
              >
                {busy ? "Verifying…" : "Verify and sign in"}
              </button>
              <button
                type="button"
                onClick={restart}
                disabled={busy}
                className="mt-4 flex w-full items-center justify-center gap-2 text-sm font-semibold text-brand-700 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4" /> Back to sign in
              </button>
            </form>
          ) : null}

          {step === "enrol" && setup ? (
            <form onSubmit={activateMfa}>
              <h1 className="font-display text-2xl font-semibold text-ink">
                Protect your account
              </h1>
              <p className="mt-2 text-sm text-ink/55">
                Your role requires two-factor authentication.
              </p>
              {error ? (
                <p
                  className="mt-5 rounded-xl bg-red-50 p-3 text-sm text-red-700"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-ink/65">
                <li>Open your authenticator app and add an account.</li>
                <li>
                  Enter this setup key:{" "}
                  <code className="break-all rounded bg-cream px-1.5 py-1 text-ink">
                    {setup.secret}
                  </code>
                </li>
                <li>Enter the generated six-digit code below.</li>
              </ol>
              <details className="mt-4 rounded-xl bg-cream p-3 text-xs text-ink/60">
                <summary className="cursor-pointer font-semibold">
                  Show authenticator URI
                </summary>
                <code className="mt-2 block break-all">{setup.otpauthUri}</code>
              </details>
              <div className="mt-6">
                <label
                  htmlFor="enrol-code"
                  className="text-sm font-medium text-ink/80"
                >
                  Verification code
                </label>
                <input
                  id="enrol-code"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\s/g, ""))
                  }
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  className={inputClass}
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className={`${buttonClass} mt-7`}
              >
                {busy ? "Activating…" : "Activate and sign in"}
              </button>
              <button
                type="button"
                onClick={restart}
                disabled={busy}
                className="mt-4 flex w-full items-center justify-center gap-2 text-sm font-semibold text-brand-700 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4" /> Back to sign in
              </button>
            </form>
          ) : null}

          {step === "recovery" ? (
            <div>
              <CheckCircle2
                className="h-9 w-9 text-brand-600"
                aria-hidden="true"
              />
              <h1 className="mt-5 font-display text-2xl font-semibold text-ink">
                Two-factor authentication is active
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-ink/55">
                Save these one-time recovery codes now. They will not be shown
                again.
              </p>
              <div
                className="mt-6 grid grid-cols-2 gap-2 rounded-xl bg-cream p-4"
                aria-label="Recovery codes"
              >
                {recoveryCodes.map((recoveryCode) => (
                  <code key={recoveryCode} className="text-xs text-ink">
                    {recoveryCode}
                  </code>
                ))}
              </div>
              <button
                type="button"
                className={`${buttonClass} mt-7`}
                onClick={async () => {
                  await completeSignIn(getSessionOrThrow());
                  router.replace(destination);
                }}
              >
                I have saved the codes
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/**
 * useSearchParams makes this subtree client-rendered, which Next requires to
 * be inside a Suspense boundary or the production build refuses to prerender
 * the route at all.
 */
export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-cream text-sm text-ink/55">
          Loading sign in…
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}

function getSessionOrThrow(): Session {
  const value = getSession();
  if (!value)
    throw new Error("The new session is unavailable. Please sign in again.");
  return value;
}
