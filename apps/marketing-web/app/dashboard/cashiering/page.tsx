"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import {
  minorBigInt,
  naira,
  nairaInputToMinor,
  type MoneyMinor,
} from "@/lib/api/money";

interface Movement {
  id: string;
  type: string;
  amountMinor: MoneyMinor;
  reference: string | null;
  note: string | null;
  createdAt: string;
}
interface Shift {
  id: string;
  shiftNumber: string;
  status: string;
  openingFloatMinor: MoneyMinor;
  expectedMinor?: MoneyMinor;
  countedMinor: MoneyMinor | null;
  varianceMinor: MoneyMinor | null;
  varianceReason: string | null;
  openedAt: string;
  movements?: Movement[];
}

export default function CashieringPage() {
  const queryClient = useQueryClient();
  const { me, selectedPropertyId } = useAuth();
  const propertyId = selectedPropertyId || me?.properties[0]?.id || "";
  const canOpen = me?.permissions.includes("cashier.open_shift") ?? false;
  const canClose = me?.permissions.includes("cashier.close_shift") ?? false;
  const canApprove =
    me?.permissions.includes("cashier.approve_variance") ?? false;
  const [openingFloat, setOpeningFloat] = useState("50000");
  const [counted, setCounted] = useState("");
  const [varianceReason, setVarianceReason] = useState("");
  const [movement, setMovement] = useState({
    type: "DROP_TO_SAFE",
    amount: "",
    note: "",
  });
  const [error, setError] = useState("");
  const shifts = useQuery({
    queryKey: ["cashier-shifts", propertyId],
    queryFn: () =>
      api<Shift[]>(
        `/cashiering/shifts?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
    refetchInterval: 15_000,
  });
  const openShift = shifts.data?.find((shift) => shift.status === "OPEN");
  const detail = useQuery({
    queryKey: ["cashier-shift", openShift?.id],
    queryFn: () => api<Shift>(`/cashiering/shifts/${openShift!.id}`),
    enabled: Boolean(openShift),
    refetchInterval: 15_000,
  });
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["cashier-shifts", propertyId],
      }),
      queryClient.invalidateQueries({ queryKey: ["cashier-shift"] }),
    ]);
  };
  const fail = (cause: unknown) =>
    setError(
      cause instanceof Error ? cause.message : "Cashiering request failed.",
    );
  const open = useMutation({
    mutationFn: () =>
      api("/cashiering/shifts", {
        method: "POST",
        body: {
          propertyId,
          openingFloatMinor: nairaInputToMinor(openingFloat),
        },
      }),
    onSuccess: async () => {
      setError("");
      await refresh();
    },
    onError: fail,
  });
  const addMovement = useMutation({
    mutationFn: () =>
      api(`/cashiering/shifts/${openShift!.id}/movements`, {
        method: "POST",
        body: {
          type: movement.type,
          amountMinor: nairaInputToMinor(movement.amount),
          ...(movement.note ? { note: movement.note } : {}),
        },
      }),
    onSuccess: async () => {
      setMovement((current) => ({ ...current, amount: "", note: "" }));
      setError("");
      await refresh();
    },
    onError: fail,
  });
  const close = useMutation({
    mutationFn: () =>
      api(`/cashiering/shifts/${openShift!.id}/close`, {
        method: "POST",
        body: {
          countedMinor: nairaInputToMinor(counted),
          ...(varianceReason ? { varianceReason } : {}),
        },
      }),
    onSuccess: async () => {
      setCounted("");
      setVarianceReason("");
      setError("");
      await refresh();
    },
    onError: fail,
  });
  const approve = useMutation({
    mutationFn: (shiftId: string) =>
      api(`/cashiering/shifts/${shiftId}/approve`, {
        method: "POST",
        body: {},
      }),
    onSuccess: refresh,
    onError: fail,
  });
  const expected = minorBigInt(detail.data?.expectedMinor ?? 0);
  let variance = 0n;
  try {
    variance = counted ? BigInt(nairaInputToMinor(counted)) - expected : 0n;
  } catch {
    variance = 0n;
  }
  const input =
    "mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500";
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Cashiering</h1>
          <p className="mt-1 text-sm text-ink/55">
            Open, reconcile, and approve accountable cash drawers.
          </p>
        </div>
        {!openShift && canOpen ? (
          <div className="flex gap-2">
            <label className="sr-only" htmlFor="opening-float">
              Opening float in naira
            </label>
            <input
              id="opening-float"
              value={openingFloat}
              onChange={(event) => setOpeningFloat(event.target.value)}
              inputMode="decimal"
              className="w-36 rounded-xl border border-ink/10 bg-white px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={!Number(openingFloat) || open.isPending}
              onClick={() => open.mutate()}
              className="rounded-xl bg-brand-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              Open shift
            </button>
          </div>
        ) : null}
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
      {openShift && detail.data ? (
        <div className="grid gap-6 xl:grid-cols-2">
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="font-semibold">
              Shift {detail.data.shiftNumber}{" "}
              <span className="ml-2 rounded-full bg-brand-50 px-2 py-1 text-[10px] text-brand-700">
                OPEN
              </span>
            </h2>
            <div className="mt-5 divide-y divide-ink/5">
              {(detail.data.movements ?? []).map((entry) => (
                <div
                  key={entry.id}
                  className="flex justify-between gap-4 py-3 text-sm"
                >
                  <span>
                    <strong className="font-medium">
                      {entry.type.replaceAll("_", " ")}
                    </strong>
                    <span className="ml-2 text-xs text-ink/40">
                      {entry.note ?? entry.reference}
                    </span>
                  </span>
                  <span
                    className={
                      minorBigInt(entry.amountMinor) < 0n ? "text-red-600" : ""
                    }
                  >
                    {naira(entry.amountMinor)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t border-ink/10 pt-4 font-semibold">
              <span>Expected in drawer</span>
              <span>{naira(expected)}</span>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-ink/60">
                Movement
                <select
                  value={movement.type}
                  onChange={(event) =>
                    setMovement((current) => ({
                      ...current,
                      type: event.target.value,
                    }))
                  }
                  className={input}
                >
                  <option value="DROP_TO_SAFE">Drop to safe</option>
                  <option value="PETTY_CASH_OUT">Petty cash out</option>
                  <option value="REFUND_OUT">Refund out</option>
                  <option value="PAYMENT_IN">Payment in</option>
                  <option value="FLOAT_IN">Float in</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-ink/60">
                Amount (₦)
                <input
                  value={movement.amount}
                  onChange={(event) =>
                    setMovement((current) => ({
                      ...current,
                      amount: event.target.value,
                    }))
                  }
                  inputMode="decimal"
                  className={input}
                />
              </label>
            </div>
            <label className="mt-3 block text-xs font-semibold text-ink/60">
              Note
              <input
                value={movement.note}
                onChange={(event) =>
                  setMovement((current) => ({
                    ...current,
                    note: event.target.value,
                  }))
                }
                className={input}
              />
            </label>
            <button
              type="button"
              disabled={!Number(movement.amount) || addMovement.isPending}
              onClick={() => addMovement.mutate()}
              className="mt-4 rounded-full border border-brand-700 px-4 py-2 text-xs font-semibold text-brand-700 disabled:opacity-50"
            >
              Record movement
            </button>
          </section>
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="font-semibold">Close shift</h2>
            <label className="mt-5 block text-xs font-semibold text-ink/60">
              Counted cash (₦)
              <input
                value={counted}
                onChange={(event) => setCounted(event.target.value)}
                inputMode="decimal"
                className={input}
              />
            </label>
            {counted ? (
              <p
                className={`mt-4 rounded-xl p-3 text-sm font-semibold ${variance === 0n ? "bg-brand-50 text-brand-700" : "bg-red-50 text-red-700"}`}
              >
                Variance: {variance === 0n ? "Balanced" : naira(variance)}
              </p>
            ) : null}
            {counted && variance !== 0n ? (
              <label className="mt-4 block text-xs font-semibold text-ink/60">
                Variance reason
                <input
                  value={varianceReason}
                  onChange={(event) => setVarianceReason(event.target.value)}
                  required
                  className={input}
                />
              </label>
            ) : null}
            {canClose ? (
              <button
                type="button"
                disabled={
                  !Number(counted) ||
                  (variance !== 0n && varianceReason.trim().length < 3) ||
                  close.isPending
                }
                onClick={() => close.mutate()}
                className="mt-6 w-full rounded-full bg-brand-800 py-3 text-sm font-semibold text-white disabled:opacity-50"
              >
                Close and reconcile shift
              </button>
            ) : null}
          </section>
        </div>
      ) : null}
      <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="px-6 py-5">
          <h2 className="font-semibold">Shift history</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3">Shift</th>
                <th className="px-4 py-3">Opened</th>
                <th className="px-4 py-3">Float</th>
                <th className="px-4 py-3">Counted</th>
                <th className="px-4 py-3">Variance</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-6 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {(shifts.data ?? []).map((shift) => (
                <tr key={shift.id} className="border-t border-ink/5">
                  <td className="px-6 py-4 font-medium">{shift.shiftNumber}</td>
                  <td className="px-4 py-4 text-ink/60">
                    {new Date(shift.openedAt).toLocaleString("en-NG")}
                  </td>
                  <td className="px-4 py-4">
                    {naira(shift.openingFloatMinor)}
                  </td>
                  <td className="px-4 py-4">
                    {shift.countedMinor == null
                      ? "—"
                      : naira(shift.countedMinor)}
                  </td>
                  <td className="px-4 py-4">
                    {shift.varianceMinor == null
                      ? "—"
                      : naira(shift.varianceMinor)}
                  </td>
                  <td className="px-4 py-4">
                    {shift.status.replaceAll("_", " ")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    {shift.status === "PENDING_APPROVAL" && canApprove ? (
                      <button
                        type="button"
                        onClick={() => approve.mutate(shift.id)}
                        className="rounded-lg bg-brand-800 px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        Approve
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!shifts.isPending && !shifts.data?.length ? (
          <p className="p-8 text-center text-sm text-ink/45">
            No cashier shifts yet.
          </p>
        ) : null}
      </section>
    </div>
  );
}
