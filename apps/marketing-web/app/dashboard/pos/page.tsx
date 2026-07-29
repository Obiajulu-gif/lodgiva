"use client";

import { useState } from "react";
import { UtensilsCrossed, Trash2, BedDouble, Banknote, CreditCard } from "lucide-react";
import { formatNaira } from "@/lib/data";

const outlets = ["Palm Restaurant", "Pool Bar", "Room Service"];

const menu = [
  { id: "m01", name: "Jollof Rice & Chicken", price: 8500, cat: "Mains" },
  { id: "m02", name: "Egusi Soup & Pounded Yam", price: 9800, cat: "Mains" },
  { id: "m03", name: "Grilled Croaker Fish", price: 14500, cat: "Mains" },
  { id: "m04", name: "Pepper Soup (Goat)", price: 7200, cat: "Starters" },
  { id: "m05", name: "Suya Platter", price: 11000, cat: "Starters" },
  { id: "m06", name: "Spring Rolls", price: 4500, cat: "Starters" },
  { id: "m07", name: "Chapman", price: 3500, cat: "Drinks" },
  { id: "m08", name: "Fresh Orange Juice", price: 3000, cat: "Drinks" },
  { id: "m09", name: "Star Lager", price: 2500, cat: "Drinks" },
  { id: "m10", name: "Red Wine (Glass)", price: 6500, cat: "Drinks" },
  { id: "m11", name: "Puff Puff & Ice Cream", price: 4800, cat: "Desserts" },
  { id: "m12", name: "Fruit Platter", price: 5500, cat: "Desserts" },
];

const cats = ["All", "Starters", "Mains", "Drinks", "Desserts"];
const VAT_BP = 750;
const SERVICE_BP = 500;

type Line = { id: string; name: string; price: number; qty: number };

export default function PosPage() {
  const [outlet, setOutlet] = useState(outlets[0]);
  const [cat, setCat] = useState("All");
  const [order, setOrder] = useState<Line[]>([]);
  const [settled, setSettled] = useState<string | null>(null);

  const add = (item: (typeof menu)[number]) => {
    setSettled(null);
    setOrder((prev) => {
      const found = prev.find((l) => l.id === item.id);
      if (found)
        return prev.map((l) =>
          l.id === item.id ? { ...l, qty: l.qty + 1 } : l
        );
      return [...prev, { id: item.id, name: item.name, price: item.price, qty: 1 }];
    });
  };

  const remove = (id: string) =>
    setOrder((prev) => prev.filter((l) => l.id !== id));

  const subtotal = order.reduce((s, l) => s + l.price * l.qty, 0);
  const service = Math.round((subtotal * SERVICE_BP) / 10000);
  const vat = Math.round(((subtotal + service) * VAT_BP) / 10000);
  const total = subtotal + service + vat;

  const settle = (method: string) => {
    setSettled(method);
    setOrder([]);
  };

  const visible = menu.filter((m) => cat === "All" || m.cat === cat);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">
            Restaurant & Bar POS
          </h1>
          <p className="mt-1 text-ink/55">
            Tap items to add them, then settle or post to a guest room folio.
          </p>
        </div>
        <div className="flex gap-2">
          {outlets.map((o) => (
            <button
              key={o}
              onClick={() => setOutlet(o)}
              className={`rounded-full px-4 py-2 text-xs font-semibold transition-colors ${
                outlet === o
                  ? "bg-brand-800 text-white"
                  : "border border-ink/10 bg-white text-ink/60 hover:border-brand-300"
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        {/* menu */}
        <div className="xl:col-span-2">
          <div className="mb-4 flex flex-wrap gap-2">
            {cats.map((c) => (
              <button
                key={c}
                onClick={() => setCat(c)}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors ${
                  cat === c
                    ? "bg-gold-400 text-brand-950"
                    : "border border-ink/10 bg-white text-ink/60"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {visible.map((m) => (
              <button
                key={m.id}
                onClick={() => add(m)}
                className="rounded-2xl border border-ink/5 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md"
              >
                <p className="text-sm font-semibold text-ink">{m.name}</p>
                <p className="mt-1 text-xs text-ink/45">{m.cat}</p>
                <p className="mt-3 font-display text-lg font-semibold text-brand-700">
                  {formatNaira(m.price)}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* ticket */}
        <div className="h-fit rounded-2xl border border-ink/5 bg-white p-6 shadow-sm">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <UtensilsCrossed className="h-4 w-4 text-brand-700" />
            Current order — {outlet}
          </h2>

          {order.length === 0 ? (
            <p className="mt-8 rounded-xl border border-dashed border-ink/10 py-10 text-center text-sm text-ink/35">
              {settled
                ? `Order settled via ${settled} ✓`
                : "No items yet — tap the menu"}
            </p>
          ) : (
            <div className="mt-5 space-y-3">
              {order.map((l) => (
                <div
                  key={l.id}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-ink/75">
                    {l.qty} × {l.name}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium text-ink">
                      {formatNaira(l.price * l.qty)}
                    </span>
                    <button
                      onClick={() => remove(l.id)}
                      aria-label={`Remove ${l.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-ink/30 hover:text-red-500" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          <dl className="mt-6 space-y-2 border-t border-ink/10 pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink/55">Subtotal</dt>
              <dd className="text-ink/80">{formatNaira(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink/55">Service (5%)</dt>
              <dd className="text-ink/80">{formatNaira(service)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink/55">VAT (7.5%)</dt>
              <dd className="text-ink/80">{formatNaira(vat)}</dd>
            </div>
            <div className="flex justify-between pt-1">
              <dt className="font-semibold text-ink">Total</dt>
              <dd className="font-display text-xl font-semibold text-brand-700">
                {formatNaira(total)}
              </dd>
            </div>
          </dl>

          <div className="mt-6 grid gap-2">
            <button
              disabled={order.length === 0}
              onClick={() => settle("room posting (Room 302)")}
              className="flex items-center justify-center gap-2 rounded-full bg-brand-800 py-3 text-sm font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-40"
            >
              <BedDouble className="h-4 w-4" />
              Post to room folio
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={order.length === 0}
                onClick={() => settle("cash")}
                className="flex items-center justify-center gap-2 rounded-full border border-ink/10 py-3 text-sm font-semibold text-ink/70 transition-colors hover:border-brand-300 disabled:opacity-40"
              >
                <Banknote className="h-4 w-4" /> Cash
              </button>
              <button
                disabled={order.length === 0}
                onClick={() => settle("card")}
                className="flex items-center justify-center gap-2 rounded-full border border-ink/10 py-3 text-sm font-semibold text-ink/70 transition-colors hover:border-brand-300 disabled:opacity-40"
              >
                <CreditCard className="h-4 w-4" /> Card
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
