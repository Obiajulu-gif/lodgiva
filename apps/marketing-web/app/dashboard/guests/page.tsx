"use client";

import { type FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, X } from "lucide-react";
import { useAuth } from "@/components/providers";
import { api } from "@/lib/api/client";
import { GuestDetails } from "./guest-details";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  vip: boolean;
  blacklistedAt: string | null;
  updatedAt: string;
}

export default function GuestsPage() {
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const canManage = me?.permissions.includes("guest.manage") ?? false;
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedGuestId, setSelectedGuestId] = useState("");
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const guests = useQuery({
    queryKey: ["guests", search],
    queryFn: () =>
      api<Guest[]>(
        `/guests${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`,
      ),
    refetchInterval: 30_000,
  });
  const createGuest = useMutation({
    mutationFn: () =>
      api<Guest>("/guests", {
        method: "POST",
        body: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
          ...(form.email.trim() ? { email: form.email.trim() } : {}),
        },
      }),
    onSuccess: async () => {
      setCreating(false);
      setForm({ firstName: "", lastName: "", phone: "", email: "" });
      setError("");
      setNotice("Guest profile created.");
      await queryClient.invalidateQueries({ queryKey: ["guests"] });
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Guest could not be created.",
      ),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createGuest.mutate();
  }
  return (
    <div className="space-y-7">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Guests</h1>
          <p className="mt-1 text-sm text-ink/55">
            Tenant-wide guest profiles with privacy-minimised identity data.
          </p>
        </div>
        {canManage ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex items-center gap-2 rounded-full bg-brand-800 px-4 py-2 text-xs font-semibold text-white"
          >
            <Plus className="h-4 w-4" /> Add guest
          </button>
        ) : null}
      </header>
      <label className="relative block max-w-md">
        <span className="sr-only">Search guests</span>
        <Search className="absolute left-4 top-3 h-4 w-4 text-ink/35" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, email, or phone"
          className="w-full rounded-xl border border-ink/10 bg-white py-2.5 pl-11 pr-4 text-sm outline-none focus:border-brand-500"
        />
      </label>
      {notice ? (
        <button
          type="button"
          onClick={() => setNotice("")}
          className="w-full rounded-xl bg-brand-50 p-3 text-left text-sm text-brand-700"
        >
          {notice} — dismiss
        </button>
      ) : null}
      {!creating && error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
        </button>
      ) : null}
      <section className="overflow-hidden rounded-2xl border border-ink/5 bg-white shadow-sm">
        {guests.isPending ? (
          <p className="p-10 text-center text-sm text-ink/45">
            Loading guest profiles…
          </p>
        ) : null}
        {guests.isError ? (
          <p className="p-6 text-sm text-red-700">{guests.error.message}</p>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="bg-cream/70 text-xs text-ink/50">
                <th className="px-6 py-3 font-medium">Guest</th>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Nationality</th>
                <th className="px-6 py-3 font-medium">Flags</th>
                <th className="px-6 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(guests.data ?? []).map((guest) => (
                <tr key={guest.id} className="border-t border-ink/5">
                  <td className="px-6 py-4 font-medium">
                    {guest.firstName} {guest.lastName}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {guest.phone ?? "—"}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {guest.email ?? "—"}
                  </td>
                  <td className="px-4 py-4 text-ink/60">
                    {guest.nationality ?? "—"}
                  </td>
                  <td className="px-6 py-4">
                    {guest.vip ? (
                      <span className="rounded-full bg-gold-100 px-2 py-1 text-[10px] font-bold text-gold-600">
                        VIP
                      </span>
                    ) : null}
                    {guest.blacklistedAt ? (
                      <span className="ml-2 rounded-full bg-red-50 px-2 py-1 text-[10px] font-bold text-red-700">
                        BLOCKED
                      </span>
                    ) : null}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      type="button"
                      onClick={() => setSelectedGuestId(guest.id)}
                      className="text-xs font-semibold text-brand-700"
                    >
                      View profile
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!guests.isPending && !guests.data?.length ? (
          <p className="p-10 text-center text-sm text-ink/45">
            No guest profiles match this search.
          </p>
        ) : null}
      </section>
      {creating && canManage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 px-5">
          <form
            onSubmit={submit}
            className="w-full max-w-lg rounded-3xl bg-white p-7 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-2xl font-semibold">Add guest</h2>
              <button
                type="button"
                onClick={() => setCreating(false)}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {error ? (
              <p
                className="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-700"
                role="alert"
              >
                {error}
              </p>
            ) : null}
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              {(["firstName", "lastName", "phone", "email"] as const).map(
                (field) => (
                  <label
                    key={field}
                    className="text-sm font-medium capitalize text-ink/75"
                  >
                    {field.replace(/([A-Z])/g, " $1")}
                    <input
                      value={form[field]}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          [field]: event.target.value,
                        }))
                      }
                      type={field === "email" ? "email" : "text"}
                      required={field === "firstName" || field === "lastName"}
                      className="mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 outline-none focus:border-brand-500"
                    />
                  </label>
                ),
              )}
            </div>
            <button
              type="submit"
              disabled={createGuest.isPending}
              className="mt-6 w-full rounded-full bg-brand-800 py-3 text-sm font-semibold text-white disabled:opacity-50"
            >
              {createGuest.isPending ? "Saving…" : "Save guest"}
            </button>
          </form>
        </div>
      ) : null}
      {selectedGuestId ? (
        <GuestDetails
          guestId={selectedGuestId}
          canManage={canManage}
          onClose={() => setSelectedGuestId("")}
          onMessage={(message, isError) => {
            if (isError) {
              setError(message);
              setNotice("");
            } else {
              setNotice(message);
              setError("");
            }
          }}
        />
      ) : null}
    </div>
  );
}
