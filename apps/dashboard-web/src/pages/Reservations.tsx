import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  source: string;
  guest: { firstName: string; lastName: string; vip: boolean };
  rooms: { roomId: string | null; room: { roomNumber: string } | null; nightlyRateMinor: number }[];
  folios: { id: string; status: string }[];
}

interface RackRoom {
  id: string;
  roomNumber: string;
  operationalStatus: string;
  roomType: { code: string };
}

interface RoomType { id: string; code: string; name: string; baseRateMinor: number }
interface Guest { id: string; firstName: string; lastName: string }

const STATUS_PILL: Record<string, string> = {
  CONFIRMED: "blue",
  CHECKED_IN: "green",
  CHECKED_OUT: "gray",
  CANCELLED: "red",
  NO_SHOW: "red",
  PENDING_PAYMENT: "gold",
};

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

export default function ReservationsPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [checkInFor, setCheckInFor] = useState<Reservation | null>(null);
  const [folioFor, setFolioFor] = useState<Reservation | null>(null);
  const [error, setError] = useState("");

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["reservations", propertyId] });
    qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
    qc.invalidateQueries({ queryKey: ["daily-flash", propertyId] });
  };

  const { data: reservations } = useQuery({
    queryKey: ["reservations", propertyId],
    queryFn: () => api<Reservation[]>(`/reservations?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });

  const checkOut = useMutation({
    mutationFn: (id: string) =>
      api(`/reservations/${id}/check-out`, { method: "POST", body: {} }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/reservations/${id}/cancel`, { method: "POST", body: { reason: "Cancelled from dashboard" } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Reservations</h1>
          <p className="sub">Full lifecycle against the live API — no mock data.</p>
        </div>
        <button onClick={() => { setError(""); setShowCreate(true); }}>+ New reservation</button>
      </div>

      {error && (
        <div className="error-box" onClick={() => setError("")} style={{ cursor: "pointer" }}>
          {error} (click to dismiss)
        </div>
      )}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Code</th><th>Guest</th><th>Room</th><th>Dates</th>
              <th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {(reservations ?? []).map((r) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "monospace", fontSize: 12, color: "var(--brand-700)" }}>
                  {r.confirmationCode}
                </td>
                <td>
                  {r.guest.firstName} {r.guest.lastName} {r.guest.vip ? "★" : ""}
                </td>
                <td>{r.rooms[0]?.room?.roomNumber ?? "—"}</td>
                <td>{r.arrivalDate} → {r.departureDate}</td>
                <td><span className={`pill ${STATUS_PILL[r.status] ?? "gray"}`}>{r.status.replace("_", " ")}</span></td>
                <td>
                  <div style={{ display: "flex", gap: 6 }}>
                    {r.status === "CONFIRMED" && (
                      <>
                        <button className="small" onClick={() => { setError(""); setCheckInFor(r); }}>
                          Check in
                        </button>
                        <button className="small secondary" onClick={() => cancel.mutate(r.id)}>
                          Cancel
                        </button>
                      </>
                    )}
                    {r.status === "CHECKED_IN" && (
                      <>
                        <button className="small" onClick={() => checkOut.mutate(r.id)}>
                          Check out
                        </button>
                        <button className="small secondary" onClick={() => setFolioFor(r)}>
                          Folio
                        </button>
                      </>
                    )}
                    {["CHECKED_OUT", "CANCELLED", "NO_SHOW"].includes(r.status) && (
                      <button className="small secondary" onClick={() => setFolioFor(r)}>
                        Folio
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!reservations?.length && (
              <tr><td colSpan={6} style={{ color: "var(--ink-50)" }}>No reservations yet — create one.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreateModal
          propertyId={propertyId}
          onClose={() => setShowCreate(false)}
          onDone={() => { setShowCreate(false); refresh(); }}
        />
      )}
      {checkInFor && (
        <CheckInModal
          propertyId={propertyId}
          reservation={checkInFor}
          onClose={() => setCheckInFor(null)}
          onDone={() => { setCheckInFor(null); refresh(); }}
        />
      )}
      {folioFor && (
        <FolioModal
          reservation={folioFor}
          onClose={() => setFolioFor(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

function CreateModal({
  propertyId, onClose, onDone,
}: { propertyId: string; onClose: () => void; onDone: () => void }) {
  const [guestId, setGuestId] = useState("");
  const [roomTypeId, setRoomTypeId] = useState("");
  const [arrival, setArrival] = useState(today());
  const [departure, setDeparture] = useState(plusDays(1));
  const [newGuest, setNewGuest] = useState({ firstName: "", lastName: "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: guests } = useQuery({
    queryKey: ["guests"],
    queryFn: () => api<Guest[]>("/guests"),
  });
  const { data: roomTypes } = useQuery({
    queryKey: ["room-types", propertyId],
    queryFn: () => api<RoomType[]>(`/properties/${propertyId}/room-types`),
  });

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      let gid = guestId;
      if (!gid) {
        if (!newGuest.firstName || !newGuest.lastName) {
          throw new Error("Select a guest or enter a new guest name.");
        }
        const created = await api<Guest>("/guests", { method: "POST", body: newGuest });
        gid = created.id;
      }
      if (!roomTypeId) throw new Error("Select a room type.");
      await api("/reservations", {
        method: "POST",
        body: {
          propertyId, guestId: gid, roomTypeId,
          arrivalDate: arrival, departureDate: departure, source: "WALK_IN",
        },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New reservation</h2>
        {error && <div className="error-box">{error}</div>}
        <div className="field">
          <label>EXISTING GUEST</label>
          <select value={guestId} onChange={(e) => setGuestId(e.target.value)}>
            <option value="">— New guest —</option>
            {(guests ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.firstName} {g.lastName}</option>
            ))}
          </select>
        </div>
        {!guestId && (
          <div className="row field">
            <div>
              <label>FIRST NAME</label>
              <input value={newGuest.firstName} onChange={(e) => setNewGuest({ ...newGuest, firstName: e.target.value })} />
            </div>
            <div>
              <label>LAST NAME</label>
              <input value={newGuest.lastName} onChange={(e) => setNewGuest({ ...newGuest, lastName: e.target.value })} />
            </div>
          </div>
        )}
        <div className="field">
          <label>ROOM TYPE</label>
          <select value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>
            <option value="">Select…</option>
            {(roomTypes ?? []).map((rt) => (
              <option key={rt.id} value={rt.id}>
                {rt.name} — {naira(rt.baseRateMinor)}/night
              </option>
            ))}
          </select>
        </div>
        <div className="row field">
          <div>
            <label>ARRIVAL</label>
            <input type="date" value={arrival} onChange={(e) => setArrival(e.target.value)} />
          </div>
          <div>
            <label>DEPARTURE</label>
            <input type="date" value={departure} onChange={(e) => setDeparture(e.target.value)} />
          </div>
        </div>
        <div className="row">
          <button className="secondary" onClick={onClose}>Close</button>
          <button disabled={busy} onClick={submit}>{busy ? "Creating…" : "Create reservation"}</button>
        </div>
      </div>
    </div>
  );
}

function CheckInModal({
  propertyId, reservation, onClose, onDone,
}: { propertyId: string; reservation: Reservation; onClose: () => void; onDone: () => void }) {
  const [roomId, setRoomId] = useState(reservation.rooms[0]?.roomId ?? "");
  const [override, setOverride] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const { data: rack } = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
  });
  const candidates = (rack ?? []).filter(
    (r) => !r.operationalStatus.startsWith("OCCUPIED") && !["OUT_OF_ORDER", "OUT_OF_SERVICE"].includes(r.operationalStatus)
  );

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api(`/reservations/${reservation.id}/check-in`, {
        method: "POST",
        body: { roomId: roomId || undefined, overrideDirtyRoom: override },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Check in {reservation.confirmationCode}</h2>
        {error && <div className="error-box">{error}</div>}
        <div className="field">
          <label>ASSIGN ROOM</label>
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Select a room…</option>
            {candidates.map((r) => (
              <option key={r.id} value={r.id}>
                {r.roomNumber} — {r.operationalStatus.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            style={{ width: "auto" }}
            id="ovr"
          />
          <label htmlFor="ovr" style={{ margin: 0 }}>
            Override dirty-room rule (recorded in the audit trail)
          </label>
        </div>
        <div className="row">
          <button className="secondary" onClick={onClose}>Close</button>
          <button disabled={busy} onClick={submit}>{busy ? "Checking in…" : "Check in"}</button>
        </div>
      </div>
    </div>
  );
}

interface FolioData {
  id: string;
  status: string;
  balanceMinor: number;
  entries: { id: string; type: string; description: string; amountMinor: number; businessDate: string }[];
}

function FolioModal({
  reservation, onClose, onChanged,
}: { reservation: Reservation; onClose: () => void; onChanged: () => void }) {
  const folioId = reservation.folios[0]?.id;
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [error, setError] = useState("");

  const { data: folio } = useQuery({
    queryKey: ["folio", folioId],
    queryFn: () => api<FolioData>(`/folios/${folioId}`),
    enabled: !!folioId,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["folio", folioId] });
    onChanged();
  };

  const pay = useMutation({
    mutationFn: () =>
      api("/payments", {
        method: "POST",
        body: {
          folioId,
          method,
          amountMinor: Math.round(Number(amount) * 100),
          idempotencyKey: `dash-${folioId}-${Date.now()}`,
        },
      }),
    onSuccess: () => { setAmount(""); invalidate(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const charge = useMutation({
    mutationFn: () =>
      api(`/folios/${folioId}/charges`, {
        method: "POST",
        body: {
          type: "POS_CHARGE",
          description: chargeDesc || "Miscellaneous charge",
          amountMinor: Math.round(Number(chargeAmount) * 100),
          applyTaxes: true,
        },
      }),
    onSuccess: () => { setChargeDesc(""); setChargeAmount(""); invalidate(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  if (!folioId) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2>
          Folio — {reservation.confirmationCode}{" "}
          <span className={`pill ${folio?.status === "OPEN" ? "green" : "gray"}`}>
            {folio?.status ?? "…"}
          </span>
        </h2>
        {error && <div className="error-box" onClick={() => setError("")}>{error}</div>}
        <table>
          <thead><tr><th>Entry</th><th>Type</th><th style={{ textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {(folio?.entries ?? []).map((e) => (
              <tr key={e.id}>
                <td>{e.description}</td>
                <td style={{ fontSize: 11, color: "var(--ink-50)" }}>{e.type}</td>
                <td style={{ textAlign: "right" }} className={e.amountMinor < 0 ? "ledger-neg" : "ledger-pos"}>
                  {naira(e.amountMinor)}
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={2}><b>Balance</b></td>
              <td style={{ textAlign: "right" }}>
                <b style={{ color: (folio?.balanceMinor ?? 0) > 0 ? "var(--gold-600)" : "var(--brand-600)" }}>
                  {naira(folio?.balanceMinor ?? 0)}
                </b>
              </td>
            </tr>
          </tbody>
        </table>

        {folio?.status === "OPEN" && (
          <>
            <div className="row mt">
              <div>
                <label>CHARGE DESCRIPTION</label>
                <input value={chargeDesc} onChange={(e) => setChargeDesc(e.target.value)} placeholder="e.g. Restaurant — dinner" />
              </div>
              <div>
                <label>AMOUNT (₦)</label>
                <input value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} inputMode="numeric" />
              </div>
            </div>
            <button
              className="small secondary mt"
              disabled={!chargeAmount || charge.isPending}
              onClick={() => charge.mutate()}
            >
              Post charge (+ VAT & service)
            </button>

            <div className="row mt">
              <div>
                <label>PAYMENT METHOD</label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="POS_TERMINAL">POS terminal</option>
                  <option value="CARD">Card (sandbox)</option>
                </select>
              </div>
              <div>
                <label>AMOUNT (₦)</label>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" />
              </div>
            </div>
            <button
              className="small mt"
              disabled={!amount || pay.isPending}
              onClick={() => pay.mutate()}
            >
              Record payment
            </button>
          </>
        )}
        <div className="row mt">
          <button className="secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
