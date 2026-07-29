import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

interface Shift {
  id: string;
  shiftNumber: string;
  status: string;
  openingFloatMinor: number;
  expectedMinor?: number;
  countedMinor: number | null;
  varianceMinor: number | null;
  varianceReason: string | null;
  openedAt: string;
  movements?: Movement[];
}
interface Movement {
  id: string;
  type: string;
  amountMinor: number;
  reference: string | null;
  note: string | null;
  createdAt: string;
}

const STATUS_PILL: Record<string, string> = {
  OPEN: "green",
  CLOSED: "gray",
  PENDING_APPROVAL: "gold",
};

export default function CashieringPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [float, setFloat] = useState("50000");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [movement, setMovement] = useState({ type: "DROP_TO_SAFE", amount: "", note: "" });

  const { data: shifts } = useQuery({
    queryKey: ["shifts", propertyId],
    queryFn: () => api<Shift[]>(`/cashiering/shifts?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });
  const openShift = shifts?.find((s) => s.status === "OPEN");

  const { data: detail } = useQuery({
    queryKey: ["shift", openShift?.id],
    queryFn: () => api<Shift>(`/cashiering/shifts/${openShift!.id}`),
    enabled: !!openShift,
    refetchInterval: 10_000,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["shifts", propertyId] });
    qc.invalidateQueries({ queryKey: ["shift", openShift?.id] });
  };
  const onError = (e: unknown) => setError(e instanceof ApiError ? e.message : String(e));

  const open = useMutation({
    mutationFn: () =>
      api("/cashiering/shifts", {
        method: "POST",
        body: { propertyId, openingFloatMinor: Math.round(Number(float) * 100) },
      }),
    onSuccess: () => { setError(""); refresh(); },
    onError,
  });

  const addMovement = useMutation({
    mutationFn: () =>
      api(`/cashiering/shifts/${openShift!.id}/movements`, {
        method: "POST",
        body: {
          type: movement.type,
          amountMinor: Math.round(Number(movement.amount) * 100),
          note: movement.note || undefined,
        },
      }),
    onSuccess: () => { setMovement({ ...movement, amount: "", note: "" }); setError(""); refresh(); },
    onError,
  });

  const close = useMutation({
    mutationFn: () =>
      api(`/cashiering/shifts/${openShift!.id}/close`, {
        method: "POST",
        body: {
          countedMinor: Math.round(Number(counted) * 100),
          varianceReason: reason || undefined,
        },
      }),
    onSuccess: () => { setCounted(""); setReason(""); setError(""); refresh(); },
    onError,
  });

  const approve = useMutation({
    mutationFn: (id: string) => api(`/cashiering/shifts/${id}/approve`, { method: "POST", body: {} }),
    onSuccess: () => { setError(""); refresh(); },
    onError,
  });

  const expected = detail?.expectedMinor ?? 0;
  const variance = counted ? Math.round(Number(counted) * 100) - expected : 0;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Cashiering</h1>
          <p className="sub">
            Open a drawer, record movements, then close with expected vs
            counted. A variance requires a reason and manager approval.
          </p>
        </div>
        {!openShift && (
          <div className="toolbar" style={{ margin: 0 }}>
            <input
              value={float}
              onChange={(e) => setFloat(e.target.value)}
              style={{ width: 130 }}
              placeholder="Float ₦"
            />
            <button disabled={open.isPending} onClick={() => open.mutate()}>Open shift</button>
          </div>
        )}
      </div>

      {error && <div className="error-box" onClick={() => setError("")}>{error}</div>}

      {openShift && detail && (
        <div className="grid cols-2">
          <div className="card">
            <h3>
              Shift {detail.shiftNumber}{" "}
              <span className={`pill ${STATUS_PILL[detail.status]}`}>{detail.status}</span>
            </h3>
            <table>
              <thead><tr><th>Movement</th><th>Note</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {(detail.movements ?? []).map((m) => (
                  <tr key={m.id}>
                    <td>{m.type.replace(/_/g, " ")}</td>
                    <td style={{ fontSize: 12, color: "var(--ink-50)" }}>{m.note ?? m.reference ?? "—"}</td>
                    <td style={{ textAlign: "right" }} className={m.amountMinor < 0 ? "ledger-neg" : ""}>
                      {naira(m.amountMinor)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}><b>Expected in drawer</b></td>
                  <td style={{ textAlign: "right" }}><b>{naira(expected)}</b></td>
                </tr>
              </tbody>
            </table>

            <div className="row mt">
              <div>
                <label>MOVEMENT</label>
                <select value={movement.type} onChange={(e) => setMovement({ ...movement, type: e.target.value })}>
                  <option value="DROP_TO_SAFE">Drop to safe</option>
                  <option value="PETTY_CASH_OUT">Petty cash out</option>
                  <option value="REFUND_OUT">Refund out</option>
                  <option value="PAYMENT_IN">Payment in</option>
                  <option value="FLOAT_IN">Float in</option>
                </select>
              </div>
              <div>
                <label>AMOUNT (₦)</label>
                <input value={movement.amount} onChange={(e) => setMovement({ ...movement, amount: e.target.value })} />
              </div>
            </div>
            <button
              className="small secondary mt"
              disabled={!movement.amount || addMovement.isPending}
              onClick={() => addMovement.mutate()}
            >
              Record movement
            </button>
          </div>

          <div className="card">
            <h3>Close shift</h3>
            <div className="field">
              <label>COUNTED CASH (₦)</label>
              <input value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="numeric" />
            </div>
            {counted && (
              <div
                className="field"
                style={{
                  background: variance === 0 ? "var(--brand-50)" : "#fef2f2",
                  color: variance === 0 ? "var(--brand-700)" : "#dc2626",
                  padding: "10px 14px", borderRadius: 10, fontWeight: 600, fontSize: 13,
                }}
              >
                Variance: {variance === 0 ? "Balanced ✓" : naira(variance)}
              </div>
            )}
            {counted && variance !== 0 && (
              <div className="field">
                <label>VARIANCE REASON (REQUIRED)</label>
                <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. short-change at dinner" />
              </div>
            )}
            <button
              style={{ width: "100%" }}
              disabled={!counted || close.isPending}
              onClick={() => close.mutate()}
            >
              Close shift
            </button>
          </div>
        </div>
      )}

      <div className="card mt">
        <h3>Shift history</h3>
        <table>
          <thead>
            <tr>
              <th>Shift</th><th>Opened</th><th>Float</th><th>Expected</th>
              <th>Counted</th><th>Variance</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(shifts ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.shiftNumber}</td>
                <td>{new Date(s.openedAt).toLocaleString()}</td>
                <td>{naira(s.openingFloatMinor)}</td>
                <td>{s.expectedMinor != null ? naira(s.expectedMinor) : "—"}</td>
                <td>{s.countedMinor != null ? naira(s.countedMinor) : "—"}</td>
                <td className={s.varianceMinor ? "ledger-neg" : ""}>
                  {s.varianceMinor != null ? naira(s.varianceMinor) : "—"}
                </td>
                <td><span className={`pill ${STATUS_PILL[s.status]}`}>{s.status.replace("_", " ")}</span></td>
                <td>
                  {s.status === "PENDING_APPROVAL" && (
                    <button className="small" onClick={() => approve.mutate(s.id)}>Approve</button>
                  )}
                </td>
              </tr>
            ))}
            {!shifts?.length && (
              <tr><td colSpan={8} style={{ color: "var(--ink-50)" }}>No shifts yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
