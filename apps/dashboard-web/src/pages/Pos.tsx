import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

interface MenuItem { id: string; code: string; name: string; category: string; priceMinor: number }
interface Outlet { id: string; code: string; name: string; menuItems: MenuItem[] }
interface Order {
  id: string;
  orderNumber: string;
  status: string;
  settlement: string | null;
  totalMinor: number;
  outlet: { name: string };
  lines: { id: string; description: string; quantity: number; lineMinor: number }[];
}
interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  guest: { firstName: string; lastName: string };
  rooms: { room: { roomNumber: string } | null }[];
  folios: { id: string; status: string }[];
}
interface Shift { id: string; shiftNumber: string; status: string }

export default function PosPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [outletId, setOutletId] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const { data: outlets } = useQuery({
    queryKey: ["outlets", propertyId],
    queryFn: () => api<Outlet[]>(`/pos/outlets?propertyId=${propertyId}`),
  });
  const { data: orders } = useQuery({
    queryKey: ["pos-orders", propertyId],
    queryFn: () => api<Order[]>(`/pos/orders?propertyId=${propertyId}`),
    refetchInterval: 10_000,
  });
  const { data: inHouse } = useQuery({
    queryKey: ["reservations", propertyId],
    queryFn: () => api<Reservation[]>(`/reservations?propertyId=${propertyId}&status=CHECKED_IN`),
  });
  const { data: shifts } = useQuery({
    queryKey: ["shifts", propertyId],
    queryFn: () => api<Shift[]>(`/cashiering/shifts?propertyId=${propertyId}`),
  });

  const outlet = outlets?.find((o) => o.id === outletId) ?? outlets?.[0];
  const openShift = shifts?.find((s) => s.status === "OPEN");

  const subtotal = useMemo(() => {
    if (!outlet) return 0;
    return Object.entries(cart).reduce((sum, [id, qty]) => {
      const item = outlet.menuItems.find((m) => m.id === id);
      return sum + (item ? item.priceMinor * qty : 0);
    }, 0);
  }, [cart, outlet]);
  const service = Math.floor((subtotal * 500) / 10000);
  const vat = Math.floor(((subtotal + service) * 750) / 10000);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pos-orders", propertyId] });
    qc.invalidateQueries({ queryKey: ["shifts", propertyId] });
    qc.invalidateQueries({ queryKey: ["daily-flash", propertyId] });
  };

  const createOrder = useMutation({
    mutationFn: () =>
      api<Order>("/pos/orders", {
        method: "POST",
        body: {
          outletId: outlet!.id,
          lines: Object.entries(cart).map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
        },
      }),
    onSuccess: (o) => {
      setCart({});
      setNotice(`Order ${o.orderNumber} opened — settle it below.`);
      setError("");
      refresh();
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const settle = useMutation({
    mutationFn: ({ id, settlement, folioId }: { id: string; settlement: string; folioId?: string }) =>
      api(`/pos/orders/${id}/settle`, {
        method: "POST",
        body: { settlement, folioId, shiftId: settlement === "CASH" ? openShift?.id : undefined },
      }),
    onSuccess: () => { setNotice("Order settled."); setError(""); refresh(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const voidOrder = useMutation({
    mutationFn: (id: string) =>
      api(`/pos/orders/${id}/void`, { method: "POST", body: { reason: "Voided from POS screen" } }),
    onSuccess: refresh,
    onError: (e) => setError(e instanceof ApiError ? e.message : String(e)),
  });

  const openFolios = (inHouse ?? []).filter((r) => r.folios.some((f) => f.status === "OPEN"));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Restaurant & Bar POS</h1>
          <p className="sub">
            Orders are priced server-side from the menu, then post to a guest
            folio or settle into the open cashier drawer.
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {(outlets ?? []).map((o) => (
            <button
              key={o.id}
              className={outlet?.id === o.id ? "" : "secondary"}
              onClick={() => { setOutletId(o.id); setCart({}); }}
            >
              {o.name}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="error-box" onClick={() => setError("")}>{error}</div>}
      {notice && !error && (
        <div className="card" style={{ background: "var(--brand-50)", marginBottom: 16, padding: 12, fontSize: 13 }}>
          {notice}
        </div>
      )}

      <div className="grid cols-2">
        <div className="card">
          <h3>{outlet?.name ?? "Menu"}</h3>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
            {(outlet?.menuItems ?? []).map((m) => (
              <button
                key={m.id}
                className="secondary"
                style={{ textAlign: "left", padding: "12px 14px", borderRadius: 12 }}
                onClick={() => setCart({ ...cart, [m.id]: (cart[m.id] ?? 0) + 1 })}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{m.name}</div>
                <div style={{ fontSize: 11, color: "var(--ink-50)" }}>{m.category}</div>
                <div style={{ color: "var(--brand-700)", marginTop: 4 }}>{naira(m.priceMinor)}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>Current ticket</h3>
          {Object.keys(cart).length === 0 ? (
            <p style={{ color: "var(--ink-50)", fontSize: 13, padding: "20px 0" }}>
              Tap menu items to build an order.
            </p>
          ) : (
            <table>
              <tbody>
                {Object.entries(cart).map(([id, qty]) => {
                  const item = outlet?.menuItems.find((m) => m.id === id);
                  if (!item) return null;
                  return (
                    <tr key={id}>
                      <td>{qty} × {item.name}</td>
                      <td style={{ textAlign: "right" }}>{naira(item.priceMinor * qty)}</td>
                      <td style={{ width: 30 }}>
                        <button
                          className="small secondary"
                          onClick={() => {
                            const next = { ...cart };
                            delete next[id];
                            setCart(next);
                          }}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr><td>Service (5%)</td><td style={{ textAlign: "right" }}>{naira(service)}</td><td /></tr>
                <tr><td>VAT (7.5%)</td><td style={{ textAlign: "right" }}>{naira(vat)}</td><td /></tr>
                <tr>
                  <td><b>Total</b></td>
                  <td style={{ textAlign: "right" }}><b>{naira(subtotal + service + vat)}</b></td>
                  <td />
                </tr>
              </tbody>
            </table>
          )}
          <button
            className="mt"
            style={{ width: "100%" }}
            disabled={!Object.keys(cart).length || createOrder.isPending}
            onClick={() => createOrder.mutate()}
          >
            Open order
          </button>
          <p className="hint">
            {openShift
              ? `Cash settlement will post to shift ${openShift.shiftNumber}.`
              : "No cashier shift is open — open one on the Cashiering page to take cash."}
          </p>
        </div>
      </div>

      <div className="card mt">
        <h3>Orders</h3>
        <table>
          <thead>
            <tr><th>Order</th><th>Outlet</th><th>Items</th><th>Total</th><th>Status</th><th>Settle</th></tr>
          </thead>
          <tbody>
            {(orders ?? []).map((o) => (
              <tr key={o.id}>
                <td style={{ fontFamily: "monospace", fontSize: 12 }}>{o.orderNumber}</td>
                <td>{o.outlet.name}</td>
                <td style={{ fontSize: 12, color: "var(--ink-50)" }}>
                  {o.lines.map((l) => `${l.quantity}× ${l.description}`).join(", ")}
                </td>
                <td>{naira(o.totalMinor)}</td>
                <td>
                  <span className={`pill ${o.status === "SETTLED" ? "green" : o.status === "VOIDED" ? "red" : "gold"}`}>
                    {o.status}{o.settlement ? ` · ${o.settlement.replace("_", " ")}` : ""}
                  </span>
                </td>
                <td>
                  {o.status === "OPEN" && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <select
                        style={{ width: 150, padding: "5px 8px", fontSize: 12 }}
                        defaultValue=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          if (v === "CASH") settle.mutate({ id: o.id, settlement: "CASH" });
                          else settle.mutate({ id: o.id, settlement: "ROOM_POSTING", folioId: v });
                          e.target.value = "";
                        }}
                      >
                        <option value="">Settle…</option>
                        <option value="CASH">Cash (drawer)</option>
                        {openFolios.map((r) => (
                          <option key={r.id} value={r.folios.find((f) => f.status === "OPEN")!.id}>
                            Room {r.rooms[0]?.room?.roomNumber ?? "?"} — {r.guest.firstName} {r.guest.lastName}
                          </option>
                        ))}
                      </select>
                      <button className="small secondary" onClick={() => voidOrder.mutate(o.id)}>Void</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!orders?.length && (
              <tr><td colSpan={6} style={{ color: "var(--ink-50)" }}>No orders yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
