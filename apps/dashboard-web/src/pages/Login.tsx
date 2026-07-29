import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, setSession, Session } from "../api";

export default function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("frontdesk@grandpalm.demo");
  const [password, setPassword] = useState("Password123!");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new ApiError(data.error?.code, data.error?.message ?? "Login failed", res.status);
      setSession(data as Session);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>Lodgiva Dashboard</h1>
        <p className="sub">Sign in to Grand Palm Hotel Lagos</p>
        {error && <div className="error-box">{error}</div>}
        <div className="field">
          <label>EMAIL</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </div>
        <div className="field">
          <label>PASSWORD</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
        </div>
        <button disabled={busy} style={{ width: "100%" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="hint">
          Seeded logins (password <code>Password123!</code>):<br />
          owner@grandpalm.demo · manager@grandpalm.demo<br />
          frontdesk@grandpalm.demo · housekeeping@grandpalm.demo
        </p>
      </form>
    </div>
  );
}
