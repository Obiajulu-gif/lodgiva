import { useQuery } from "@tanstack/react-query";
import { api, naira } from "../api";

interface Flash {
  businessDate: string;
  totalRooms: number;
  occupied: number;
  occupancyPct: number;
  arrivalsToday: number;
  departuresToday: number;
  revenueTodayMinor: number;
  outstandingMinor: number;
  paymentsByMethod: { method: string; count: number; totalMinor: number }[];
}

export default function OverviewPage({ propertyId }: { propertyId: string }) {
  const { data: flash } = useQuery({
    queryKey: ["daily-flash", propertyId],
    queryFn: () => api<Flash>(`/reports/daily-flash?propertyId=${propertyId}`),
    refetchInterval: 15_000,
  });
  const { data: audit } = useQuery({
    queryKey: ["audit", propertyId],
    queryFn: () =>
      api<{ id: string; action: string; entityType: string; createdAt: string; summary: string }[]>(
        `/reports/audit-trail?propertyId=${propertyId}`
      ),
    refetchInterval: 15_000,
  });

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Daily Flash</h1>
          <p className="sub">Business date {flash?.businessDate ?? "…"} · live from the API</p>
        </div>
        <span className="badge">● Online · Synced</span>
      </div>

      <div className="grid cols-4">
        <div className="card kpi">
          <div className="label">Occupancy</div>
          <div className="value">{flash?.occupancyPct ?? 0}%</div>
          <div className="sub">{flash?.occupied ?? 0} of {flash?.totalRooms ?? 0} rooms in-house</div>
        </div>
        <div className="card kpi">
          <div className="label">Revenue (business date)</div>
          <div className="value">{naira(flash?.revenueTodayMinor ?? 0)}</div>
          <div className="sub">Charges incl. VAT & service</div>
        </div>
        <div className="card kpi">
          <div className="label">Movements today</div>
          <div className="value">{flash?.arrivalsToday ?? 0} in · {flash?.departuresToday ?? 0} out</div>
          <div className="sub">Arrivals / departures</div>
        </div>
        <div className="card kpi">
          <div className="label">Outstanding balances</div>
          <div className="value">{naira(flash?.outstandingMinor ?? 0)}</div>
          <div className="sub">Open folios owing</div>
        </div>
      </div>

      <div className="grid cols-2 mt">
        <div className="card">
          <h3>Payments by method (confirmed)</h3>
          <table>
            <thead><tr><th>Method</th><th>Count</th><th>Total</th></tr></thead>
            <tbody>
              {(flash?.paymentsByMethod ?? []).map((p) => (
                <tr key={p.method}>
                  <td>{p.method.replace("_", " ")}</td>
                  <td>{p.count}</td>
                  <td>{naira(p.totalMinor)}</td>
                </tr>
              ))}
              {!flash?.paymentsByMethod?.length && (
                <tr><td colSpan={3} style={{ color: "var(--ink-50)" }}>No payments yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3>Audit trail (append-only)</h3>
          <table>
            <thead><tr><th>Action</th><th>Entity</th><th>When</th></tr></thead>
            <tbody>
              {(audit ?? []).slice(0, 8).map((a) => (
                <tr key={a.id}>
                  <td>{a.action}</td>
                  <td>{a.entityType}</td>
                  <td>{new Date(a.createdAt).toLocaleTimeString()}</td>
                </tr>
              ))}
              {!audit?.length && (
                <tr><td colSpan={3} style={{ color: "var(--ink-50)" }}>No activity yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
