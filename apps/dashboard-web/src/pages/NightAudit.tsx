import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

interface AuditRun {
  id: string;
  businessDate: string;
  completedAt: string;
  summary: {
    occupancyPct: number;
    occupied: number;
    totalRooms: number;
    roomChargesPosted: number;
    roomRevenueMinor: number;
    adrMinor: number;
    revparMinor: number;
  };
}

export default function NightAuditPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const { data: history } = useQuery({
    queryKey: ["night-audit", propertyId],
    queryFn: () => api<AuditRun[]>(`/night-audit/history?propertyId=${propertyId}`),
  });

  const run = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>("/night-audit/run", {
        method: "POST",
        body: { propertyId },
      }),
    onSuccess: (data) => {
      setResult(data);
      setError("");
      qc.invalidateQueries();
    },
    onError: (e) => {
      setResult(null);
      setError(e instanceof ApiError ? e.message : String(e));
    },
  });

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Night Audit</h1>
          <p className="sub">
            Posts room charges for every in-house night, snapshots KPIs and
            advances the business date. Idempotent — rerunning the same date is
            rejected.
          </p>
        </div>
        <button className="gold" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "Running…" : "Run night audit"}
        </button>
      </div>

      {error && <div className="error-box">{error}</div>}
      {result && (
        <div className="card" style={{ background: "var(--brand-50)", marginBottom: 16 }}>
          <h3>Audit completed ✓</h3>
          <p style={{ fontSize: 13 }}>
            Occupancy <b>{String(result.occupancyPct)}%</b> ·{" "}
            {String(result.roomChargesPosted)} room charge(s) posted ·{" "}
            room revenue <b>{naira(Number(result.roomRevenueMinor))}</b> ·{" "}
            business date advanced to <b>{String(result.newBusinessDate)}</b>
          </p>
        </div>
      )}

      <div className="card">
        <h3>Previous runs</h3>
        <table>
          <thead>
            <tr>
              <th>Business date</th><th>Occupancy</th><th>Charges posted</th>
              <th>Room revenue</th><th>ADR</th><th>RevPAR</th><th>Completed</th>
            </tr>
          </thead>
          <tbody>
            {(history ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.businessDate}</td>
                <td>{r.summary.occupancyPct}% ({r.summary.occupied}/{r.summary.totalRooms})</td>
                <td>{r.summary.roomChargesPosted}</td>
                <td>{naira(r.summary.roomRevenueMinor ?? 0)}</td>
                <td>{naira(r.summary.adrMinor ?? 0)}</td>
                <td>{naira(r.summary.revparMinor ?? 0)}</td>
                <td>{new Date(r.completedAt).toLocaleString()}</td>
              </tr>
            ))}
            {!history?.length && (
              <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>No audit runs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
