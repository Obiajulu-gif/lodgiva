import { useQuery } from "@tanstack/react-query";
import { api, naira } from "../api";

interface Payment {
  id: string;
  method: string;
  provider: string | null;
  amountMinor: number;
  status: string;
  externalReference: string | null;
  receivedAt: string;
  folio: {
    guest: { firstName: string; lastName: string };
    reservation: { confirmationCode: string } | null;
  };
}

const STATUS_PILL: Record<string, string> = {
  CONFIRMED: "green",
  PENDING: "gold",
  REFUNDED: "blue",
  FAILED: "red",
};

export default function PaymentsPage({ propertyId }: { propertyId: string }) {
  const { data: payments } = useQuery({
    queryKey: ["payments", propertyId],
    queryFn: () => api<Payment[]>(`/payments?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });

  const total = (payments ?? [])
    .filter((p) => p.status === "CONFIRMED")
    .reduce((s, p) => s + p.amountMinor, 0);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Payments</h1>
          <p className="sub">
            Recorded via the payment provider abstraction — payments post a
            negative ledger entry on the guest folio.
          </p>
        </div>
        <span className="badge">Confirmed: {naira(total)}</span>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Guest / Reservation</th><th>Method</th><th>Provider</th>
              <th>Reference</th><th>When</th><th>Status</th>
              <th style={{ textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {(payments ?? []).map((p) => (
              <tr key={p.id}>
                <td>
                  {p.folio.guest.firstName} {p.folio.guest.lastName}
                  <span style={{ color: "var(--ink-50)", fontSize: 11 }}>
                    {" "}{p.folio.reservation?.confirmationCode ?? ""}
                  </span>
                </td>
                <td>{p.method.replace("_", " ")}</td>
                <td>{p.provider ?? "—"}</td>
                <td style={{ fontFamily: "monospace", fontSize: 11 }}>{p.externalReference ?? "—"}</td>
                <td>{new Date(p.receivedAt).toLocaleString()}</td>
                <td><span className={`pill ${STATUS_PILL[p.status] ?? "gray"}`}>{p.status}</span></td>
                <td style={{ textAlign: "right", fontWeight: 600 }}>{naira(p.amountMinor)}</td>
              </tr>
            ))}
            {!payments?.length && (
              <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>No payments yet — take one from a reservation folio.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
