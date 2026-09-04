import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, setSession, Session } from "../api";

type LoginResult =
  | Session
  | { status: "MFA_REQUIRED"; mfaToken: string; message: string }
  | {
      status: "MFA_ENROLMENT_REQUIRED";
      setupToken: string;
      role: string;
      message: string;
    };

type MfaSetup = { secret: string; otpauthUri: string; message: string };
type ActivatedSession = Session & { recoveryCodes: string[]; message: string };
type Step = "password" | "mfa" | "enrol" | "recovery";

async function postAuth<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`/api/v1/auth/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = data as { error?: { code?: string; message?: string } };
    throw new ApiError(
      problem.error?.code ?? "AUTHENTICATION_FAILED",
      problem.error?.message ?? "Sign in failed. Please try again.",
      response.status
    );
  }
  return data as T;
}

export default function LoginPage() {
  const navigate = useNavigate();
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

  const finishSignIn = (session: Session) => {
    setSession(session);
    navigate("/", { replace: true });
  };

  const fail = (err: unknown, fallback: string) => {
    setError(err instanceof Error ? err.message : fallback);
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await postAuth<LoginResult>("login", {
        email: email.trim().toLowerCase(),
        password,
      });
      setPassword("");
      if ("status" in result && result.status === "MFA_REQUIRED") {
        setChallengeToken(result.mfaToken);
        setStep("mfa");
        return;
      }
      if ("status" in result && result.status === "MFA_ENROLMENT_REQUIRED") {
        setSetupToken(result.setupToken);
        const nextSetup = await postAuth<MfaSetup>("mfa/enrol/setup", {
          setupToken: result.setupToken,
        });
        setSetup(nextSetup);
        setStep("enrol");
        return;
      }
      finishSignIn(result as Session);
    } catch (err) {
      fail(err, "Sign in failed");
    } finally {
      setBusy(false);
    }
  };

  const submitMfa = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await postAuth<Session>("mfa/verify", {
        mfaToken: challengeToken,
        code: code.trim(),
      });
      finishSignIn(session);
    } catch (err) {
      fail(err, "The verification code could not be checked");
    } finally {
      setBusy(false);
    }
  };

  const activateMfa = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await postAuth<ActivatedSession>("mfa/enrol/activate", {
        setupToken,
        code: code.trim(),
      });
      setSession(result);
      setRecoveryCodes(result.recoveryCodes);
      setStep("recovery");
    } catch (err) {
      fail(err, "Two-factor authentication could not be activated");
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setSession(null);
    setStep("password");
    setPassword("");
    setCode("");
    setChallengeToken("");
    setSetupToken("");
    setSetup(null);
    setRecoveryCodes([]);
    setError("");
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Lodgiva Dashboard</h1>

        {step === "password" && (
          <form onSubmit={submitPassword}>
            <p className="sub">Sign in to your property workspace</p>
            {error && <div className="error-box" role="alert">{error}</div>}
            <div className="field">
              <label htmlFor="login-email">EMAIL</label>
              <input
                id="login-email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="login-password">PASSWORD</label>
              <input
                id="login-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <button disabled={busy} style={{ width: "100%" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <p className="hint">Use the work email provided by your property administrator.</p>
          </form>
        )}

        {step === "mfa" && (
          <form onSubmit={submitMfa}>
            <p className="sub">Enter your authenticator code or a recovery code.</p>
            {error && <div className="error-box" role="alert">{error}</div>}
            <div className="field">
              <label htmlFor="mfa-code">VERIFICATION CODE</label>
              <input
                id="mfa-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </div>
            <button disabled={busy} style={{ width: "100%" }}>
              {busy ? "Verifying…" : "Verify and sign in"}
            </button>
            <button type="button" className="secondary login-secondary" onClick={restart} disabled={busy}>
              Back to sign in
            </button>
          </form>
        )}

        {step === "enrol" && setup && (
          <form onSubmit={activateMfa}>
            <p className="sub">Your role requires two-factor authentication.</p>
            {error && <div className="error-box" role="alert">{error}</div>}
            <ol className="mfa-steps">
              <li>Open your authenticator app and add an account.</li>
              <li>Enter this setup key: <code className="setup-key">{setup.secret}</code></li>
              <li>Enter the six-digit code it generates below.</li>
            </ol>
            <details className="mfa-uri">
              <summary>Authenticator setup URI</summary>
              <code>{setup.otpauthUri}</code>
            </details>
            <div className="field">
              <label htmlFor="enrol-code">VERIFICATION CODE</label>
              <input
                id="enrol-code"
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\s/g, ""))}
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </div>
            <button disabled={busy} style={{ width: "100%" }}>
              {busy ? "Activating…" : "Activate and sign in"}
            </button>
            <button type="button" className="secondary login-secondary" onClick={restart} disabled={busy}>
              Back to sign in
            </button>
          </form>
        )}

        {step === "recovery" && (
          <div>
            <p className="sub">Two-factor authentication is active.</p>
            <div className="success-box">Save these one-time recovery codes now. They will not be shown again.</div>
            <div className="recovery-codes" aria-label="Recovery codes">
              {recoveryCodes.map((recoveryCode) => <code key={recoveryCode}>{recoveryCode}</code>)}
            </div>
            <button onClick={() => navigate("/", { replace: true })} style={{ width: "100%" }}>
              I have saved the codes
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
