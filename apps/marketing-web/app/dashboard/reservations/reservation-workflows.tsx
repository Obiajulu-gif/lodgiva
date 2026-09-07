"use client";

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { api } from "@/lib/api/client";
import {
  minorBigInt,
  naira,
  nairaInputToMinor,
  type MoneyMinor,
} from "@/lib/api/money";
import type { PropertySummary } from "@/lib/api/types";

export interface Reservation {
  id: string;
  confirmationCode: string;
  status: string;
  source: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  guest: { id: string; firstName: string; lastName: string; vip: boolean };
  rooms: {
    roomId: string | null;
    roomTypeId: string;
    room: { roomNumber: string } | null;
    nightlyRateMinor: MoneyMinor;
  }[];
  folios: { id: string; status: string }[];
}

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
}
interface Availability {
  roomTypeId: string;
  code: string;
  name: string;
  baseRateMinor: MoneyMinor;
  totalRooms: number;
  available: number;
}
interface RackRoom {
  id: string;
  roomNumber: string;
  roomTypeId: string;
  operationalStatus: string;
  occupant: unknown | null;
}
interface Folio {
  id: string;
  status: string;
  balanceMinor: MoneyMinor;
  entries: {
    id: string;
    type: string;
    description: string;
    amountMinor: MoneyMinor;
    businessDate: string;
  }[];
}

const field =
  "mt-2 w-full rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500 disabled:bg-cream";

function addDays(iso: string, amount: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + amount))
    .toISOString()
    .slice(0, 10);
}

function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 px-4 py-8"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onClose(); }
          if (event.key !== "Tab") return;
          const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]',
          ) ?? []);
          const first = elements[0];
          const last = elements.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }}
        aria-modal="true"
        aria-labelledby="reservation-dialog-title"
        className={`max-h-full w-full overflow-y-auto rounded-3xl bg-white p-6 shadow-2xl sm:p-8 ${wide ? "max-w-3xl" : "max-w-xl"}`}
      >
        <div className="flex items-center justify-between gap-4">
          <h2
            id="reservation-dialog-title"
            className="font-display text-2xl font-semibold"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-2 hover:bg-ink/5"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function CreateReservationDialog({
  property,
  permissions,
  onClose,
  onDone,
}: {
  property: PropertySummary;
  permissions: string[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const canCreateGuest = permissions.includes("guest.manage");
  const [guestMode, setGuestMode] = useState<"existing" | "new">("existing");
  const [guestSearch, setGuestSearch] = useState("");
  const [guestId, setGuestId] = useState("");
  const [newGuest, setNewGuest] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
  });
  const [arrival, setArrival] = useState(property.businessDate);
  const [departure, setDeparture] = useState(addDays(property.businessDate, 1));
  const [roomTypeId, setRoomTypeId] = useState("");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [source, setSource] = useState("WALK_IN");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const guests = useQuery({
    queryKey: ["guest-search", guestSearch],
    queryFn: () =>
      api<Guest[]>(
        `/guests${guestSearch.trim() ? `?q=${encodeURIComponent(guestSearch.trim())}` : ""}`,
      ),
  });
  const validDates = arrival >= property.businessDate && departure > arrival;
  const availability = useQuery({
    queryKey: ["reservation-availability", property.id, arrival, departure],
    queryFn: () =>
      api<Availability[]>(
        `/reservations/availability?propertyId=${encodeURIComponent(property.id)}&arrival=${arrival}&departure=${departure}`,
      ),
    enabled: validDates,
  });
  const create = useMutation({
    mutationFn: async () => {
      if (!validDates || !availability.data?.some((item) => item.roomTypeId === roomTypeId && item.available > 0)) {
        throw new Error("Select valid dates and an available room type.");
      }
      let selectedGuestId = guestId;
      if (guestMode === "new") {
        if (!canCreateGuest)
          throw new Error("Your role cannot create guest profiles.");
        const created = await api<Guest>("/guests", {
          method: "POST",
          body: {
            firstName: newGuest.firstName.trim(),
            lastName: newGuest.lastName.trim(),
            ...(newGuest.phone.trim() ? { phone: newGuest.phone.trim() } : {}),
            ...(newGuest.email.trim() ? { email: newGuest.email.trim() } : {}),
          },
        });
        selectedGuestId = created.id;
        // Keep the created guest if inventory is lost between availability
        // and booking, so retrying does not create duplicate profiles.
        setGuestId(created.id);
        setGuestMode("existing");
        setGuestSearch(`${created.firstName} ${created.lastName}`);
      }
      if (!selectedGuestId) throw new Error("Select an existing guest.");
      if (!roomTypeId) throw new Error("Select an available room type.");
      return api<Reservation>("/reservations", {
        method: "POST",
        body: {
          propertyId: property.id,
          guestId: selectedGuestId,
          roomTypeId,
          arrivalDate: arrival,
          departureDate: departure,
          adults: Number(adults),
          children: Number(children),
          source,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
    },
    onSuccess: () => onDone(),
    onError: (cause) =>
      setError(
        cause instanceof Error
          ? cause.message
          : "Reservation could not be created.",
      ),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    create.mutate();
  }
  return (
    <Dialog title="New reservation" onClose={() => { if (!create.isPending) onClose(); }} wide>
      <form onSubmit={submit} className="mt-6 space-y-5">
        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {guests.isError ? <p role="alert" className="text-sm text-red-700">Could not load guests: {guests.error.message} <button type="button" onClick={() => void guests.refetch()}>Retry guests</button></p> : null}
        {availability.isError ? <p role="alert" className="text-sm text-red-700">Could not load availability: {availability.error.message} <button type="button" onClick={() => void availability.refetch()}>Retry availability</button></p> : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setGuestMode("existing")}
            className={`rounded-full px-4 py-2 text-xs font-semibold ${guestMode === "existing" ? "bg-brand-800 text-white" : "bg-cream text-ink/60"}`}
          >
            Existing guest
          </button>
          {canCreateGuest ? (
            <button
              type="button"
              onClick={() => setGuestMode("new")}
              className={`rounded-full px-4 py-2 text-xs font-semibold ${guestMode === "new" ? "bg-brand-800 text-white" : "bg-cream text-ink/60"}`}
            >
              New guest
            </button>
          ) : null}
        </div>
        {guestMode === "existing" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-ink/60">
              Search guests
              <input
                value={guestSearch}
                onChange={(event) => setGuestSearch(event.target.value)}
                className={field}
                placeholder="Name, phone, or email"
              />
            </label>
            <label className="text-xs font-semibold text-ink/60">
              Guest
              <select
                value={guestId}
                onChange={(event) => setGuestId(event.target.value)}
                required
                className={field}
              >
                <option value="">Select…</option>
                {guests.data?.map((guest) => (
                  <option key={guest.id} value={guest.id}>
                    {guest.firstName} {guest.lastName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(["firstName", "lastName", "phone", "email"] as const).map(
              (key) => (
                <label
                  key={key}
                  className="text-xs font-semibold capitalize text-ink/60"
                >
                  {key.replace(/([A-Z])/g, " $1")}
                  <input
                    type={key === "email" ? "email" : "text"}
                    value={newGuest[key]}
                    onChange={(event) =>
                      setNewGuest((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                    required={key === "firstName" || key === "lastName"}
                    className={field}
                  />
                </label>
              ),
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-semibold text-ink/60">
            Arrival
            <input
              type="date"
              min={property.businessDate}
              value={arrival}
              onChange={(event) => { setArrival(event.target.value); setRoomTypeId(""); }}
              required
              className={field}
            />
          </label>
          <label className="text-xs font-semibold text-ink/60">
            Departure
            <input
              type="date"
              min={addDays(arrival, 1)}
              value={departure}
              onChange={(event) => { setDeparture(event.target.value); setRoomTypeId(""); }}
              required
              className={field}
            />
          </label>
        </div>
        <label className="block text-xs font-semibold text-ink/60">
          Available room type
          <select
            value={roomTypeId}
            onChange={(event) => setRoomTypeId(event.target.value)}
            required
            disabled={!validDates || availability.isFetching}
            className={field}
          >
            <option value="">
              {availability.isFetching ? "Checking availability…" : "Select…"}
            </option>
            {availability.data
              ?.filter((item) => item.available > 0)
              .map((item) => (
                <option key={item.roomTypeId} value={item.roomTypeId}>
                  {item.name} · {item.available} available ·{" "}
                  {naira(item.baseRateMinor)}/night
                </option>
              ))}
          </select>
          {validDates &&
          availability.isSuccess &&
          !availability.isFetching &&
          !availability.data?.some((item) => item.available > 0) ? (
            <span className="mt-2 block text-xs text-red-600">
              No room types are available for these dates.
            </span>
          ) : null}
        </label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-xs font-semibold text-ink/60">
            Adults
            <input
              type="number"
              min="1"
              max="10"
              value={adults}
              onChange={(event) => setAdults(event.target.value)}
              className={field}
            />
          </label>
          <label className="text-xs font-semibold text-ink/60">
            Children
            <input
              type="number"
              min="0"
              max="10"
              value={children}
              onChange={(event) => setChildren(event.target.value)}
              className={field}
            />
          </label>
          <label className="text-xs font-semibold text-ink/60">
            Source
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className={field}
            >
              <option value="WALK_IN">Walk in</option>
              <option value="DIRECT">Direct</option>
              <option value="PHONE">Phone</option>
              <option value="CORPORATE">Corporate</option>
            </select>
          </label>
        </div>
        <label className="block text-xs font-semibold text-ink/60">
          Notes
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            className={field}
          />
        </label>
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-full border border-ink/10 px-5 py-2.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={create.isPending || !validDates || availability.isFetching || !availability.data?.some((item) => item.roomTypeId === roomTypeId && item.available > 0)}
            className="rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {create.isPending ? "Creating…" : "Create reservation"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function CheckInDialog({
  propertyId,
  reservation,
  allowDirtyOverride,
  onClose,
  onDone,
}: {
  propertyId: string;
  reservation: Reservation;
  allowDirtyOverride: boolean;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [roomId, setRoomId] = useState(reservation.rooms[0]?.roomId ?? "");
  const [overrideDirtyRoom, setOverrideDirtyRoom] = useState(false);
  const [error, setError] = useState("");
  const roomTypeId = reservation.rooms[0]?.roomTypeId;
  const rooms = useQuery({
    queryKey: ["room-rack", propertyId],
    queryFn: () => api<RackRoom[]>(`/properties/${propertyId}/room-rack`),
  });
  const candidates = (rooms.data ?? []).filter(
    (room) =>
      room.roomTypeId === roomTypeId &&
      !room.occupant &&
      ["VACANT_CLEAN", "VACANT_DIRTY", "INSPECTED"].includes(room.operationalStatus),
  );
  const checkIn = useMutation({
    mutationFn: () =>
      api(`/reservations/${reservation.id}/check-in`, {
        method: "POST",
        body: { roomId, overrideDirtyRoom },
      }),
    onSuccess: () => onDone(),
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : "Check-in failed."),
  });
  return (
    <Dialog
      title={`Check in ${reservation.confirmationCode}`}
      onClose={() => { if (!checkIn.isPending) onClose(); }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          checkIn.mutate();
        }}
        className="mt-6 space-y-5"
      >
        {error ? (
          <p
            role="alert"
            className="rounded-xl bg-red-50 p-3 text-sm text-red-700"
          >
            {error}
          </p>
        ) : null}
        {rooms.isPending ? <p role="status">Loading available rooms…</p> : null}
        {rooms.isError ? <p role="alert">{rooms.error.message} <button type="button" onClick={() => void rooms.refetch()}>Retry rooms</button></p> : null}
        {rooms.isSuccess && !candidates.length ? <p>No compatible vacant rooms. Review the Room Rack or contact housekeeping.</p> : null}
        <label className="block text-xs font-semibold text-ink/60">
          Room
          <select
            value={roomId}
            onChange={(event) => setRoomId(event.target.value)}
            required
            className={field}
          >
            <option value="">Select a compatible room…</option>
            {candidates.map((room) => (
              <option key={room.id} value={room.id}>
                {room.roomNumber} ·{" "}
                {room.operationalStatus.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        {allowDirtyOverride ? (
          <label className="flex items-start gap-3 rounded-xl bg-gold-100/60 p-3 text-sm text-ink/70">
            <input
              type="checkbox"
              checked={overrideDirtyRoom}
              onChange={(event) => setOverrideDirtyRoom(event.target.checked)}
              className="mt-0.5"
            />
            Override the dirty-room rule. This exception is written to the audit
            trail.
          </label>
        ) : null}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-ink/10 px-5 py-2.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!candidates.some((room) => room.id === roomId) || rooms.isFetching || checkIn.isPending}
            className="rounded-full bg-brand-800 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {checkIn.isPending ? "Checking in…" : "Check in guest"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function FolioDialog({
  reservation,
  permissions,
  onClose,
  onChanged,
}: {
  reservation: Reservation;
  permissions: string[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const folioId = reservation.folios[0]?.id ?? "";
  const canCharge = permissions.includes("folio.post_charge");
  const canPay = permissions.includes("payment.capture");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [chargeDescription, setChargeDescription] = useState("");
  const [chargeAmount, setChargeAmount] = useState("");
  const [error, setError] = useState("");
  const idempotencyKey = useRef(`dashboard-${folioId}-${crypto.randomUUID()}`);
  const folio = useQuery({
    queryKey: ["folio", folioId],
    queryFn: () => api<Folio>(`/folios/${folioId}`),
    enabled: Boolean(folioId),
  });
  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ["folio", folioId] });
    await onChanged();
  }
  const payment = useMutation({
    mutationFn: () =>
      api("/payments", {
        method: "POST",
        body: {
          folioId,
          method,
          amountMinor: nairaInputToMinor(amount),
          ...(reference.trim() ? { externalReference: reference.trim() } : {}),
          idempotencyKey: idempotencyKey.current,
        },
      }),
    onSuccess: async () => {
      setAmount("");
      setReference("");
      idempotencyKey.current = `dashboard-${folioId}-${crypto.randomUUID()}`;
      await refresh();
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Payment was not recorded.",
      ),
  });
  const charge = useMutation({
    mutationFn: () =>
      api(`/folios/${folioId}/charges`, {
        method: "POST",
        body: {
          type: "OTHER",
          description: chargeDescription.trim(),
          amountMinor: nairaInputToMinor(chargeAmount),
          applyTaxes: true,
        },
      }),
    onSuccess: async () => {
      setChargeAmount("");
      setChargeDescription("");
      await refresh();
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : "Charge was not posted.",
      ),
  });
  if (!folioId) return null;
  return (
    <Dialog
      title={`Folio · ${reservation.confirmationCode}`}
      onClose={onClose}
      wide
    >
      {folio.isPending ? <p role="status" className="mt-5">Loading folio…</p> : null}
      {folio.isError ? <p role="alert" className="mt-5 text-sm text-red-700">{folio.error.message} <button type="button" onClick={() => void folio.refetch()}>Retry folio</button></p> : null}
      {error ? (
        <button
          type="button"
          onClick={() => setError("")}
          className="mt-5 w-full rounded-xl bg-red-50 p-3 text-left text-sm text-red-700"
        >
          {error} — dismiss
        </button>
      ) : null}
      <div className="mt-6 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="bg-cream/70 text-xs text-ink/50">
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Entry</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {folio.data?.entries.map((entry) => (
              <tr key={entry.id} className="border-t border-ink/5">
                <td className="px-4 py-3 text-ink/50">{entry.businessDate}</td>
                <td className="px-4 py-3">{entry.description}</td>
                <td className="px-4 py-3 text-xs text-ink/45">
                  {entry.type.replaceAll("_", " ")}
                </td>
                <td
                  className={`px-4 py-3 text-right font-semibold ${minorBigInt(entry.amountMinor) < 0n ? "text-brand-700" : ""}`}
                >
                  {naira(entry.amountMinor)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-ink/10">
              <td colSpan={3} className="px-4 py-4 font-semibold">
                Balance
              </td>
              <td className="px-4 py-4 text-right font-display text-xl font-semibold">
                {folio.data ? naira(folio.data.balanceMinor) : "—"}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {folio.data?.status === "OPEN" ? (
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          {canCharge ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                charge.mutate();
              }}
              className="rounded-2xl bg-cream p-5"
            >
              <h3 className="font-semibold">Post charge</h3>
              <label className="mt-4 block text-xs font-semibold text-ink/60">
                Description
                <input
                  value={chargeDescription}
                  onChange={(event) => setChargeDescription(event.target.value)}
                  required
                  className={field}
                />
              </label>
              <label className="mt-4 block text-xs font-semibold text-ink/60">
                Amount (₦)
                <input
                  value={chargeAmount}
                  onChange={(event) => setChargeAmount(event.target.value)}
                  inputMode="decimal"
                  required
                  className={field}
                />
              </label>
              <button
                type="submit"
                disabled={charge.isPending}
                className="mt-4 rounded-full border border-brand-700 px-4 py-2 text-xs font-semibold text-brand-700 disabled:opacity-50"
              >
                {charge.isPending ? "Posting…" : "Post charge with tax"}
              </button>
            </form>
          ) : null}
          {canPay ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                payment.mutate();
              }}
              className="rounded-2xl bg-cream p-5"
            >
              <h3 className="font-semibold">Record payment</h3>
              <label className="mt-4 block text-xs font-semibold text-ink/60">
                Method
                <select
                  value={method}
                  onChange={(event) => setMethod(event.target.value)}
                  className={field}
                >
                  <option value="CASH">Cash</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="POS_TERMINAL">POS terminal</option>
                  <option value="CARD">Card</option>
                  <option value="PAYMENT_LINK">Payment link</option>
                </select>
              </label>
              <label className="mt-4 block text-xs font-semibold text-ink/60">
                Amount (₦)
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  required
                  className={field}
                />
              </label>
              {!["CASH", "BANK_TRANSFER", "POS_TERMINAL"].includes(method) ? (
                <label className="mt-4 block text-xs font-semibold text-ink/60">
                  Provider reference
                  <input
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    required
                    className={field}
                  />
                </label>
              ) : null}
              <button
                type="submit"
                disabled={payment.isPending}
                className="mt-4 rounded-full bg-brand-800 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                {payment.isPending ? "Recording…" : "Record confirmed payment"}
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="rounded-full border border-ink/10 px-5 py-2.5 text-sm font-semibold"
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}
