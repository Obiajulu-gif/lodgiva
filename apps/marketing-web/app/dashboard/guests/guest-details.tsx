"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { X } from "lucide-react";
import { api } from "@/lib/api/client";

interface GuestDetail {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  notes: string | null;
  vip: boolean;
  marketingConsent: boolean;
  blacklistedAt: string | null;
  reservations: {
    id: string;
    confirmationCode: string;
    status: string;
    arrivalDate: string;
    departureDate: string;
  }[];
}

type Editable = Pick<
  GuestDetail,
  | "firstName"
  | "lastName"
  | "phone"
  | "email"
  | "nationality"
  | "notes"
  | "vip"
  | "marketingConsent"
>;

const field =
  "mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500 disabled:bg-cream";

export function GuestDetails({
  guestId,
  canManage,
  onClose,
  onMessage,
}: {
  guestId: string;
  canManage: boolean;
  onClose: () => void;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Partial<Editable>>({});
  const detail = useQuery({
    queryKey: ["guest", guestId],
    queryFn: () => api<GuestDetail>(`/guests/${guestId}`),
  });
  const save = useMutation({
    mutationFn: () =>
      api<GuestDetail>(`/guests/${guestId}`, {
        method: "PATCH",
        body: changes,
      }),
    onSuccess: async () => {
      setChanges({});
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["guest", guestId] }),
        queryClient.invalidateQueries({ queryKey: ["guests"] }),
      ]);
      onMessage("Guest profile saved.");
      onClose();
    },
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Guest could not be saved.",
        true,
      ),
  });
  const guest = detail.data;
  const value = <K extends keyof Editable>(key: K) =>
    changes[key] ?? guest?.[key] ?? "";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink/45 px-4 py-8">
      <div className="mx-auto w-full max-w-3xl rounded-3xl bg-white p-7 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-2xl font-semibold">
              {guest ? `${guest.firstName} ${guest.lastName}` : "Guest profile"}
            </h2>
            <p className="mt-1 text-xs text-ink/45">
              Contact preferences and the latest ten reservations.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close guest profile"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {detail.isPending ? (
          <p className="mt-8 rounded-xl bg-cream p-6 text-center text-sm text-ink/45">
            Loading guest profile…
          </p>
        ) : null}
        {detail.isError ? (
          <p className="mt-6 rounded-xl bg-red-50 p-4 text-sm text-red-700">
            {detail.error.message}
          </p>
        ) : null}
        {save.isError ? (
          <p className="mt-6 rounded-xl bg-red-50 p-4 text-sm text-red-700">
            {save.error.message}
          </p>
        ) : null}
        {guest ? (
          <>
            <form onSubmit={submit} className="mt-6">
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    "firstName",
                    "lastName",
                    "phone",
                    "email",
                    "nationality",
                  ] as const
                ).map((key) => (
                  <label
                    key={key}
                    className="text-xs font-semibold capitalize text-ink/60"
                  >
                    {key.replace(/([A-Z])/g, " $1")}
                    <input
                      disabled={!canManage}
                      type={key === "email" ? "email" : "text"}
                      required={key === "firstName" || key === "lastName"}
                      value={String(value(key))}
                      onChange={(event) =>
                        setChanges((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                      className={field}
                    />
                  </label>
                ))}
                <label className="text-xs font-semibold text-ink/60 sm:col-span-2">
                  Notes
                  <textarea
                    disabled={!canManage}
                    rows={3}
                    value={String(value("notes"))}
                    onChange={(event) =>
                      setChanges((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                    className={field}
                  />
                </label>
              </div>
              <div className="mt-4 flex flex-wrap gap-5 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={Boolean(value("vip"))}
                    onChange={(event) =>
                      setChanges((current) => ({
                        ...current,
                        vip: event.target.checked,
                      }))
                    }
                  />
                  VIP guest
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    disabled={!canManage}
                    checked={Boolean(value("marketingConsent"))}
                    onChange={(event) =>
                      setChanges((current) => ({
                        ...current,
                        marketingConsent: event.target.checked,
                      }))
                    }
                  />
                  Marketing consent recorded
                </label>
                {guest.blacklistedAt ? (
                  <span className="font-semibold text-red-700">
                    Booking restricted
                  </span>
                ) : null}
              </div>
              {canManage ? (
                <button
                  type="submit"
                  disabled={save.isPending || !Object.keys(changes).length}
                  className="mt-5 rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {save.isPending ? "Saving…" : "Save profile"}
                </button>
              ) : null}
            </form>
            <section className="mt-8 border-t border-ink/5 pt-6">
              <h3 className="font-semibold">Stay history</h3>
              {guest.reservations.length ? (
                <div className="mt-3 divide-y divide-ink/5 rounded-xl border border-ink/5">
                  {guest.reservations.map((reservation) => (
                    <div
                      key={reservation.id}
                      className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
                    >
                      <div>
                        <strong className="font-mono">
                          {reservation.confirmationCode}
                        </strong>
                        <p className="text-xs text-ink/45">
                          {reservation.arrivalDate} to{" "}
                          {reservation.departureDate}
                        </p>
                      </div>
                      <span className="rounded-full bg-cream px-3 py-1 text-xs font-semibold">
                        {reservation.status.replaceAll("_", " ")}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-3 rounded-xl bg-cream p-5 text-sm text-ink/45">
                  No reservations recorded for this guest.
                </p>
              )}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
