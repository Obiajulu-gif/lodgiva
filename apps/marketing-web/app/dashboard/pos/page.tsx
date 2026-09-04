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

export default function PosPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const [outletId, setOutletId] = useState("");
  const [tableRef, setTableRef] = useState("");
  const [cart, setCart] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
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
  const effectiveOutletId = outletId || outlets.data?.[0]?.id || "";
  const outlet = outlets.data?.find(
    (candidate) => candidate.id === effectiveOutletId,
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
      await queryClient.invalidateQueries({
        queryKey: ["pos-orders", propertyId],
      });
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Order could not be created.",
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
        </div>
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
