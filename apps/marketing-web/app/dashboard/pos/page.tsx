"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Minus, Plus, ShoppingBag } from "lucide-react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { naira, type MoneyMinor } from "@/lib/api/money";

interface MenuItem {
  id: string;
  name: string;
  category: string;
  priceMinor: MoneyMinor;
}
interface Outlet {
  id: string;
  name: string;
  code: string;
  menuItems: MenuItem[];
}
interface Order {
  id: string;
  orderNumber: string;
  status: string;
  settlement: string | null;
  tableRef: string | null;
  totalMinor: MoneyMinor;
  createdAt: string;
  outlet: { name: string };
  lines: {
    id: string;
    description: string;
    quantity: number;
    lineMinor: MoneyMinor;
  }[];
}
interface InHouseReservation {
  id: string;
  guest: { firstName: string; lastName: string };
  rooms: { room: { roomNumber: string } | null }[];
  folios: { id: string; status: string }[];
}
interface Shift {
  id: string;
  shiftNumber: string;
  status: string;
}
interface Approval {
  id: string;
  type: string;
  entityId: string;
  amountMinor: MoneyMinor | null;
  reason: string;
}

export default function PosPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canApprove = me?.permissions.includes("approval.decide") ?? false;
  const [outletId, setOutletId] = useState("");
  const [tableRef, setTableRef] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [voidFor, setVoidFor] = useState<Order | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const outlets = useQuery({
    queryKey: ["pos-outlets", propertyId],
    queryFn: () =>
      api<Outlet[]>(
        `/pos/outlets?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
  });
  const orders = useQuery({
    queryKey: ["pos-orders", propertyId],
    queryFn: () =>
      api<Order[]>(`/pos/orders?propertyId=${encodeURIComponent(propertyId)}`),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const inHouse = useQuery({
    queryKey: ["pos-in-house", propertyId],
    queryFn: () =>
      api<InHouseReservation[]>(
        `/reservations?propertyId=${encodeURIComponent(propertyId)}&status=CHECKED_IN`,
      ),
    enabled: Boolean(propertyId),
  });
  const shifts = useQuery({
    queryKey: ["cashier-shifts", propertyId],
    queryFn: () =>
      api<Shift[]>(
        `/cashiering/shifts?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const approvals = useQuery({
    queryKey: ["pos-approvals", propertyId],
    queryFn: () =>
      api<Approval[]>(
        `/approvals?propertyId=${encodeURIComponent(propertyId)}&status=PENDING`,
      ),
    enabled: Boolean(propertyId) && canApprove,
    refetchInterval: 15_000,
  });
  const effectiveOutletId = outletId || outlets.data?.[0]?.id || "";
  const outlet = outlets.data?.find(
    (candidate) => candidate.id === effectiveOutletId,
  );
  const openShift = shifts.data?.find((shift) => shift.status === "OPEN");
  const openFolios = (inHouse.data ?? []).filter((reservation) =>
    reservation.folios.some((folio) => folio.status === "OPEN"),
  );
  const pendingVoids = (approvals.data ?? []).filter(
    (approval) => approval.type === "POS_VOID",
  );
  const lines = Object.entries(cart)
    .filter(([, quantity]) => quantity > 0)
    .map(([menuItemId, quantity]) => ({ menuItemId, quantity }));
  const createOrder = useMutation({
    mutationFn: () =>
      api<Order>("/pos/orders", {
        method: "POST",
        body: {
          outletId: effectiveOutletId,
          ...(tableRef.trim() ? { tableRef: tableRef.trim() } : {}),
          lines,
        },
      }),
    onSuccess: async () => {
      setCart({});
      setTableRef("");
      setError("");
      setNotice("Order opened. Choose a settlement method below.");
      await queryClient.invalidateQueries({
        queryKey: ["pos-orders", propertyId],
      });
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Order could not be created.",
      ),
  });
  async function refreshOrders(message: string) {
    setError("");
    setNotice(message);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["pos-orders", propertyId] }),
      queryClient.invalidateQueries({
        queryKey: ["pos-approvals", propertyId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["cashier-shifts", propertyId],
      }),
      queryClient.invalidateQueries({ queryKey: ["daily-flash", propertyId] }),
    ]);
  }
  const settle = useMutation({
    mutationFn: ({
      id,
      settlement,
      folioId,
    }: {
      id: string;
      settlement: string;
      folioId?: string;
    }) =>
      api(`/pos/orders/${id}/settle`, {
        method: "POST",
        body: {
          settlement,
          ...(folioId ? { folioId } : {}),
          ...(settlement === "CASH" && openShift
            ? { shiftId: openShift.id }
            : {}),
        },
      }),
    onSuccess: () => refreshOrders("Order settled and persisted."),
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Order could not be settled.",
      ),
  });
  const voidOrder = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<{ status: string; message: string | null }>(
        `/pos/orders/${id}/void`,
        {
          method: "POST",
          body: { reason },
        },
      ),
    onSuccess: async (result) => {
      setVoidFor(null);
      setVoidReason("");
      await refreshOrders(
        result.status === "PENDING_APPROVAL"
          ? (result.message ?? "Void sent for approval.")
          : "Order voided.",
      );
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Order could not be voided.",
      ),
  });
  const decideVoid = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      api(`/approvals/${id}/${approve ? "approve" : "reject"}`, {
        method: "POST",
        body: {},
      }),
    onSuccess: (_, variables) =>
      refreshOrders(
        variables.approve
          ? "Void approved."
          : "Void rejected; order returned to service.",
      ),
    onError: (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Approval could not be recorded.",
      ),
  });
  function change(itemId: string, amount: number) {
    setCart((current) => ({
      ...current,
      [itemId]: Math.max(0, (current[itemId] ?? 0) + amount),
    }));
  }
  return (
    <div className="space-y-7">
      <header>
        <h1 className="font-display text-3xl font-semibold">Point of Sale</h1>
        <p className="mt-1 text-sm text-ink/55">
          Orders are priced and taxed by the server; the browser never supplies
          monetary totals.
        </p>
      </header>
      {error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
        </button>
      ) : null}
      {notice ? (
        <button
          type="button"
          onClick={() => setNotice("")}
          className="w-full rounded-xl bg-brand-50 p-3 text-left text-sm text-brand-700"
        >
          {notice} — dismiss
        </button>
      ) : null}
      {voidFor ? (
        <section className="rounded-2xl border border-red-100 bg-white p-6 shadow-sm">
          <h2 className="font-semibold">
            Void {voidFor.orderNumber} · {naira(voidFor.totalMinor)}
          </h2>
          <p className="mt-1 text-xs text-ink/50">
            The reason is permanent. Larger or older voids require approval from
            another authorised user.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <input
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="Reason for void"
              autoFocus
              className="min-w-60 flex-1 rounded-xl border border-ink/10 px-3 py-2.5 text-sm"
            />
            <button
              type="button"
              disabled={voidReason.trim().length < 3 || voidOrder.isPending}
              onClick={() =>
                voidOrder.mutate({ id: voidFor.id, reason: voidReason.trim() })
              }
              className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Submit void
            </button>
            <button
              type="button"
              onClick={() => {
                setVoidFor(null);
                setVoidReason("");
              }}
              className="rounded-xl border border-ink/10 px-4 py-2 text-sm font-semibold"
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold">Menu</h2>
            {(outlets.data?.length ?? 0) > 1 ? (
              <select
                value={effectiveOutletId}
                onChange={(event) => {
                  setOutletId(event.target.value);
                  setCart({});
                }}
                className="rounded-xl border border-ink/10 px-3 py-2 text-sm"
              >
                {outlets.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm text-ink/50">{outlet?.name}</span>
            )}
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {(outlet?.menuItems ?? []).map((item) => (
              <div key={item.id} className="rounded-xl border border-ink/8 p-4">
                <div className="flex justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{item.name}</h3>
                    <p className="mt-1 text-xs text-ink/45">{item.category}</p>
                  </div>
                  <strong className="text-sm">{naira(item.priceMinor)}</strong>
                </div>
                <div className="mt-4 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => change(item.id, -1)}
                    disabled={!cart[item.id]}
                    aria-label={`Remove one ${item.name}`}
                    className="rounded-lg border border-ink/10 p-1.5 disabled:opacity-30"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="w-5 text-center text-sm font-semibold">
                    {cart[item.id] ?? 0}
                  </span>
                  <button
                    type="button"
                    onClick={() => change(item.id, 1)}
                    aria-label={`Add one ${item.name}`}
                    className="rounded-lg bg-brand-800 p-1.5 text-white"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {!outlets.isPending && !outlet?.menuItems.length ? (
            <p className="mt-8 rounded-xl bg-cream p-8 text-center text-sm text-ink/45">
              No active menu items are configured for this outlet.
            </p>
          ) : null}
        </section>
        <aside className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-brand-700" />
            <h2 className="font-semibold">New order</h2>
          </div>
          <label className="mt-5 block text-xs font-semibold text-ink/60">
            Table / reference
            <input
              value={tableRef}
              onChange={(event) => setTableRef(event.target.value)}
              className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500"
            />
          </label>
          <div className="mt-5 divide-y divide-ink/5">
            {lines.map((line) => {
              const item = outlet?.menuItems.find(
                (entry) => entry.id === line.menuItemId,
              );
              return (
                <div
                  key={line.menuItemId}
                  className="flex justify-between py-3 text-sm"
                >
                  <span>
                    {line.quantity} × {item?.name}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setCart((current) => ({
                        ...current,
                        [line.menuItemId]: 0,
                      }))
                    }
                    className="text-xs font-semibold text-red-600"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
          {!lines.length ? (
            <p className="mt-6 text-center text-sm text-ink/40">
              Add menu items to begin.
            </p>
          ) : null}
          <button
            type="button"
            disabled={
              !effectiveOutletId || !lines.length || createOrder.isPending
            }
            onClick={() => createOrder.mutate()}
            className="mt-6 w-full rounded-full bg-brand-800 py-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {createOrder.isPending ? "Opening order…" : "Open order"}
          </button>
        </aside>
      </div>
      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="px-6 py-5">
          <h2 className="font-semibold">Recent orders</h2>
          <p className="mt-1 text-xs text-ink/50">
            Cash settlement requires an open cashier shift. Room charges are
            posted to an open in-house folio.
          </p>
        </div>
        {canApprove && pendingVoids.length ? (
          <div className="border-y border-amber-100 bg-amber-50/70 px-6 py-4">
            <h3 className="text-sm font-semibold text-amber-950">
              Void approvals
            </h3>
            <div className="mt-3 space-y-2">
              {pendingVoids.map((approval) => {
                const order = orders.data?.find(
                  (candidate) => candidate.id === approval.entityId,
                );
                return (
                  <div
                    key={approval.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3 text-sm"
                  >
                    <div>
                      <p className="font-medium">
                        {order?.orderNumber ?? "POS order"} ·{" "}
                        {approval.amountMinor !== null
                          ? naira(approval.amountMinor)
                          : "Amount unavailable"}
                      </p>
                      <p className="text-xs text-ink/50">
                        Reason: {approval.reason}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={decideVoid.isPending}
                        onClick={() =>
                          decideVoid.mutate({ id: approval.id, approve: false })
                        }
                        className="rounded-lg border border-ink/10 px-3 py-2 text-xs font-semibold disabled:opacity-50"
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={decideVoid.isPending}
                        onClick={() =>
                          decideVoid.mutate({ id: approval.id, approve: true })
                        }
                        className="rounded-lg bg-brand-800 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Approve
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3">Order</th>
                <th className="px-4 py-3">Outlet</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Opened</th>
                <th className="px-6 py-3 text-right">Total</th>
                <th className="px-6 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(orders.data ?? []).map((order) => (
                <tr key={order.id} className="border-t border-ink/5">
                  <td className="px-6 py-4 font-medium">{order.orderNumber}</td>
                  <td className="px-4 py-4 text-ink/60">{order.outlet.name}</td>
                  <td className="px-4 py-4 text-ink/60">
                    {order.tableRef ?? "—"}
                  </td>
                  <td className="px-4 py-4">
                    {order.status.replaceAll("_", " ")}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {new Date(order.createdAt).toLocaleString("en-NG")}
                  </td>
                  <td className="px-6 py-4 text-right font-semibold">
                    {naira(order.totalMinor)}
                  </td>
                  <td className="min-w-64 px-6 py-4">
                    {order.status === "OPEN" ? (
                      <div className="flex items-center gap-2">
                        <select
                          defaultValue=""
                          aria-label={`Settle ${order.orderNumber}`}
                          disabled={settle.isPending || voidOrder.isPending}
                          onChange={(event) => {
                            const value = event.target.value;
                            if (!value) return;
                            if (value.startsWith("folio:")) {
                              settle.mutate({
                                id: order.id,
                                settlement: "ROOM_POSTING",
                                folioId: value.slice(6),
                              });
                            } else {
                              settle.mutate({
                                id: order.id,
                                settlement: value,
                              });
                            }
                            event.currentTarget.value = "";
                          }}
                          className="min-w-40 rounded-lg border border-ink/10 px-2 py-2 text-xs disabled:opacity-50"
                        >
                          <option value="">Settle order…</option>
                          <option value="CASH" disabled={!openShift}>
                            Cash
                            {openShift
                              ? ` · ${openShift.shiftNumber}`
                              : " · open shift required"}
                          </option>
                          <option value="CARD">Card</option>
                          <option value="POS_TERMINAL">POS terminal</option>
                          <option value="TRANSFER">Bank transfer</option>
                          {openFolios.map((reservation) => {
                            const folio = reservation.folios.find(
                              (candidate) => candidate.status === "OPEN",
                            );
                            const room = reservation.rooms.find(
                              (assignment) => assignment.room,
                            )?.room?.roomNumber;
                            return folio ? (
                              <option
                                key={folio.id}
                                value={`folio:${folio.id}`}
                              >
                                Room {room ?? "—"} ·{" "}
                                {reservation.guest.firstName}{" "}
                                {reservation.guest.lastName}
                              </option>
                            ) : null;
                          })}
                        </select>
                        <button
                          type="button"
                          disabled={settle.isPending || voidOrder.isPending}
                          onClick={() => {
                            setVoidFor(order);
                            setVoidReason("");
                            setNotice("");
                          }}
                          className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50"
                        >
                          Void
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-ink/50">
                        {order.settlement?.replaceAll("_", " ") ??
                          "No action required"}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!orders.isPending && !orders.data?.length ? (
          <p className="p-8 text-center text-sm text-ink/45">
            No POS orders yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}
