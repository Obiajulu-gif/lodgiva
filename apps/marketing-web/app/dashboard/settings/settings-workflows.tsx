"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { naira, nairaInputToMinor, type MoneyMinor } from "@/lib/api/money";

interface Amenity {
  id: string;
  code: string;
  name: string;
  category: string;
}
interface RoomType {
  id: string;
  code: string;
  name: string;
  baseRateMinor: MoneyMinor;
  baseOccupancy: number;
  maxOccupancy: number;
  amenities: { amenity: Amenity }[];
  _count: { rooms: number };
}
interface Room {
  id: string;
  roomNumber: string;
  floor: number;
  operationalStatus: string;
  roomType: { id: string; code: string; name: string };
  blocks: { id: string }[];
}
interface RoomBlock {
  id: string;
  type: string;
  reason: string;
  startDate: string;
  endDate: string;
  status: string;
  room: { roomNumber: string };
}
interface TaxRule {
  id: string;
  code: string;
  name: string;
  rateBp: number;
  version: number;
  appliesTo: string;
  basis: string;
  effectiveFrom: string;
}
interface Membership {
  id: string;
  role: string;
  status: string;
  allProperties: boolean;
  propertyIds: string[];
  user: {
    email: string;
    fullName: string;
    lastLoginAt: string | null;
    mfaEnabled: boolean;
  };
}
interface Invitation {
  id: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  expiresAt: string;
}

const TABS = [
  "Room types",
  "Rooms",
  "Amenities",
  "Blocks",
  "Taxes",
  "Team",
] as const;
type Tab = (typeof TABS)[number];
const ROLES = [
  "TENANT_OWNER",
  "GENERAL_MANAGER",
  "FRONT_DESK",
  "CASHIER",
  "HOUSEKEEPING",
  "MAINTENANCE",
  "FINANCE",
  "AUDITOR",
];
const field =
  "rounded-xl border border-ink/10 px-3 py-2.5 text-sm outline-none focus:border-brand-500";
const action =
  "rounded-full bg-brand-800 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40";

function percentageToBasisPoints(value: string) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match)
    throw new TypeError(
      "Enter a percentage with no more than two decimal places.",
    );
  const basisPoints =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  if (basisPoints > 10_000)
    throw new RangeError("Tax rate cannot exceed 100%.");
  return basisPoints;
}

export function SettingsWorkflows({
  propertyId,
  permissions,
  taxRules,
  onMessage,
}: {
  propertyId: string;
  permissions: string[];
  taxRules: TaxRule[];
  onMessage: (message: string, error?: boolean) => void;
}) {
  const [tab, setTab] = useState<Tab>("Room types");
  const canManageRooms = permissions.includes("settings.room.manage");
  const canBlock = permissions.includes("room.block");
  const canManageTaxes = permissions.includes("settings.tax.manage");
  const canManageUsers = permissions.includes("user.manage");

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm">
      <div className="flex flex-wrap gap-2 border-b border-ink/5 pb-4">
        {TABS.filter((item) => item !== "Team" || canManageUsers).map(
          (item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-full px-4 py-2 text-sm font-semibold ${tab === item ? "bg-brand-800 text-white" : "bg-cream text-ink/60"}`}
            >
              {item}
            </button>
          ),
        )}
      </div>
      <div className="pt-6">
        {tab === "Room types" ? (
          <RoomTypes
            propertyId={propertyId}
            canManage={canManageRooms}
            onMessage={onMessage}
          />
        ) : null}
        {tab === "Rooms" ? (
          <Rooms
            propertyId={propertyId}
            canManage={canManageRooms}
            onMessage={onMessage}
          />
        ) : null}
        {tab === "Amenities" ? (
          <Amenities
            propertyId={propertyId}
            canManage={canManageRooms}
            onMessage={onMessage}
          />
        ) : null}
        {tab === "Blocks" ? (
          <Blocks
            propertyId={propertyId}
            canManage={canBlock}
            onMessage={onMessage}
          />
        ) : null}
        {tab === "Taxes" ? (
          <Taxes
            propertyId={propertyId}
            canManage={canManageTaxes}
            rules={taxRules}
            onMessage={onMessage}
          />
        ) : null}
        {tab === "Team" && canManageUsers ? (
          <Team propertyId={propertyId} onMessage={onMessage} />
        ) : null}
      </div>
    </section>
  );
}

type ChildProps = {
  propertyId: string;
  canManage: boolean;
  onMessage: (message: string, error?: boolean) => void;
};

function useConfiguration<T>(propertyId: string, resource: string) {
  return useQuery({
    queryKey: ["configuration", propertyId, resource],
    queryFn: () =>
      api<T>(
        `/config/${resource}?propertyId=${encodeURIComponent(propertyId)}`,
      ),
    enabled: Boolean(propertyId),
  });
}

function Empty({ children }: { children: string }) {
  return (
    <p className="rounded-xl bg-cream p-5 text-center text-sm text-ink/45">
      {children}
    </p>
  );
}

function RoomTypes({ propertyId, canManage, onMessage }: ChildProps) {
  const queryClient = useQueryClient();
  const query = useConfiguration<RoomType[]>(propertyId, "room-types");
  const [form, setForm] = useState({
    code: "",
    name: "",
    rate: "",
    baseOccupancy: "2",
    maxOccupancy: "2",
  });
  const refresh = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["configuration", propertyId, "room-types"],
      }),
      queryClient.invalidateQueries({ queryKey: ["settings", propertyId] }),
    ]);
    onMessage(message);
  };
  const create = useMutation({
    mutationFn: () =>
      api("/config/room-types", {
        method: "POST",
        body: {
          propertyId,
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          baseRateMinor: nairaInputToMinor(form.rate),
          baseOccupancy: Number(form.baseOccupancy),
          maxOccupancy: Number(form.maxOccupancy),
          amenityIds: [],
        },
      }),
    onSuccess: () => {
      setForm({
        code: "",
        name: "",
        rate: "",
        baseOccupancy: "2",
        maxOccupancy: "2",
      });
      void refresh("Room type created.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Room type could not be created.",
        true,
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/config/room-types/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh("Room type deleted."),
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Room type could not be deleted.",
        true,
      ),
  });
  return (
    <div className="space-y-5">
      <Heading title="Room types" readOnly={!canManage} />
      {canManage ? (
        <div className="grid gap-3 md:grid-cols-5">
          <input
            className={field}
            placeholder="Code"
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })}
          />
          <input
            className={`${field} md:col-span-2`}
            placeholder="Name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <input
            className={field}
            placeholder="Rate (₦)"
            inputMode="decimal"
            value={form.rate}
            onChange={(event) => setForm({ ...form, rate: event.target.value })}
          />
          <button
            type="button"
            className={action}
            disabled={
              create.isPending ||
              form.code.trim().length < 2 ||
              form.name.trim().length < 2 ||
              !form.rate
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Add room type"}
          </button>
        </div>
      ) : null}
      {query.isError ? <Empty>{query.error.message}</Empty> : null}
      {query.isPending ? <Empty>Loading room types…</Empty> : null}
      {query.data?.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-ink/45">
                <th className="py-3">Code</th>
                <th>Name</th>
                <th>Rate</th>
                <th>Sleeps</th>
                <th>Rooms</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {query.data.map((item) => (
                <tr key={item.id} className="border-t border-ink/5">
                  <td className="py-3 font-mono">{item.code}</td>
                  <td>{item.name}</td>
                  <td>{naira(item.baseRateMinor)}</td>
                  <td>{item.maxOccupancy}</td>
                  <td>{item._count.rooms}</td>
                  <td className="text-right">
                    {canManage ? (
                      <button
                        type="button"
                        disabled={remove.isPending || item._count.rooms > 0}
                        title={
                          item._count.rooms
                            ? "Delete its rooms first"
                            : "Delete room type"
                        }
                        onClick={() =>
                          window.confirm(`Delete room type ${item.code}?`) &&
                          remove.mutate(item.id)
                        }
                        className="text-xs font-semibold text-red-700 disabled:text-ink/25"
                      >
                        Delete
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !query.isPending ? (
        <Empty>No room types configured.</Empty>
      ) : null}
    </div>
  );
}

function Rooms({ propertyId, canManage, onMessage }: ChildProps) {
  const queryClient = useQueryClient();
  const rooms = useConfiguration<Room[]>(propertyId, "rooms");
  const types = useConfiguration<RoomType[]>(propertyId, "room-types");
  const [form, setForm] = useState({
    roomTypeId: "",
    roomNumber: "",
    floor: "1",
  });
  const refresh = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["configuration", propertyId, "rooms"],
      }),
      queryClient.invalidateQueries({ queryKey: ["room-rack", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["configuration", propertyId, "room-types"] }),
      queryClient.invalidateQueries({ queryKey: ["settings", propertyId] }),
    ]);
    onMessage(message);
  };
  const create = useMutation({
    mutationFn: () =>
      api("/config/rooms", {
        method: "POST",
        body: {
          propertyId,
          roomTypeId: form.roomTypeId,
          roomNumber: form.roomNumber.trim(),
          floor: Number(form.floor),
          amenityIds: [],
        },
      }),
    onSuccess: () => {
      setForm((current) => ({ ...current, roomNumber: "" }));
      void refresh("Room created.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Room could not be created.",
        true,
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/config/rooms/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh("Room deleted."),
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Room could not be deleted.",
        true,
      ),
  });
  return (
    <div className="space-y-5">
      <Heading title="Rooms" readOnly={!canManage} />
      {canManage ? (
        <div className="grid gap-3 md:grid-cols-4">
          <select
            className={field}
            value={form.roomTypeId}
            onChange={(event) =>
              setForm({ ...form, roomTypeId: event.target.value })
            }
          >
            <option value="">Room type…</option>
            {types.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.code} · {item.name}
              </option>
            ))}
          </select>
          <input
            className={field}
            placeholder="Room number"
            value={form.roomNumber}
            onChange={(event) =>
              setForm({ ...form, roomNumber: event.target.value })
            }
          />
          <input
            className={field}
            type="number"
            min="0"
            max="60"
            placeholder="Floor"
            value={form.floor}
            onChange={(event) =>
              setForm({ ...form, floor: event.target.value })
            }
          />
          <button
            type="button"
            className={action}
            disabled={
              create.isPending || !form.roomTypeId || !form.roomNumber.trim()
            }
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Add room"}
          </button>
        </div>
      ) : null}
      {rooms.isError ? <Empty>{rooms.error.message}</Empty> : null}
      {rooms.isPending ? <Empty>Loading rooms…</Empty> : null}
      {rooms.data?.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rooms.data.map((room) => (
            <div key={room.id} className="rounded-xl border border-ink/5 p-4">
              <div className="flex justify-between">
                <div>
                  <strong>Room {room.roomNumber}</strong>
                  <p className="text-xs text-ink/45">
                    {room.roomType.name} · floor {room.floor}
                  </p>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    disabled={remove.isPending}
                    onClick={() =>
                      window.confirm(`Delete room ${room.roomNumber}?`) &&
                      remove.mutate(room.id)
                    }
                    className="text-xs font-semibold text-red-700"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
              <span className="mt-3 inline-block rounded-full bg-cream px-2 py-1 text-[11px] font-semibold">
                {room.operationalStatus.replaceAll("_", " ")}
              </span>
            </div>
          ))}
        </div>
      ) : !rooms.isPending ? (
        <Empty>No rooms configured.</Empty>
      ) : null}
    </div>
  );
}

function Amenities({ propertyId, canManage, onMessage }: ChildProps) {
  const queryClient = useQueryClient();
  const query = useConfiguration<Amenity[]>(propertyId, "amenities");
  const [form, setForm] = useState({ code: "", name: "", category: "ROOM" });
  const refresh = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["configuration", propertyId, "amenities"],
      }),
      queryClient.invalidateQueries({ queryKey: ["settings", propertyId] }),
    ]);
    onMessage(message);
  };
  const create = useMutation({
    mutationFn: () =>
      api("/config/amenities", {
        method: "POST",
        body: {
          propertyId,
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          category: form.category,
        },
      }),
    onSuccess: () => {
      setForm({ code: "", name: "", category: "ROOM" });
      void refresh("Amenity created.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Amenity could not be created.",
        true,
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/config/amenities/${id}`, { method: "DELETE" }),
    onSuccess: () => void refresh("Amenity deleted."),
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Amenity could not be deleted.",
        true,
      ),
  });
  return (
    <div className="space-y-5">
      <Heading title="Amenities" readOnly={!canManage} />
      {canManage ? (
        <div className="grid gap-3 md:grid-cols-4">
          <input
            className={field}
            placeholder="Code"
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })}
          />
          <input
            className={field}
            placeholder="Name"
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <select
            className={field}
            value={form.category}
            onChange={(event) =>
              setForm({ ...form, category: event.target.value })
            }
          >
            {["ROOM", "BATHROOM", "TECH", "ACCESSIBILITY", "PROPERTY"].map(
              (item) => (
                <option key={item}>{item}</option>
              ),
            )}
          </select>
          <button
            type="button"
            className={action}
            disabled={
              create.isPending ||
              form.code.trim().length < 2 ||
              form.name.trim().length < 2
            }
            onClick={() => create.mutate()}
          >
            Add amenity
          </button>
        </div>
      ) : null}
      {query.isError ? <Empty>{query.error.message}</Empty> : null}
      {query.isPending ? <Empty>Loading amenities…</Empty> : null}
      {query.data?.length ? (
        <div className="flex flex-wrap gap-3">
          {query.data.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-3 rounded-xl border border-ink/5 px-4 py-3"
            >
              <span>
                <strong className="font-mono text-sm">{item.code}</strong>
                <small className="ml-2 text-ink/45">
                  {item.name} · {item.category}
                </small>
              </span>
              {canManage ? (
                <button
                  type="button"
                  disabled={remove.isPending}
                  onClick={() =>
                    window.confirm(`Delete ${item.name}?`) &&
                    remove.mutate(item.id)
                  }
                  className="text-xs font-semibold text-red-700"
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : !query.isPending ? (
        <Empty>No amenities configured.</Empty>
      ) : null}
    </div>
  );
}

function Blocks({ propertyId, canManage, onMessage }: ChildProps) {
  const queryClient = useQueryClient();
  const rooms = useConfiguration<Room[]>(propertyId, "rooms");
  const blocks = useQuery({
    queryKey: ["configuration", propertyId, "room-blocks"],
    queryFn: () =>
      api<RoomBlock[]>(
        `/config/room-blocks?propertyId=${encodeURIComponent(propertyId)}&status=ALL`,
      ),
  });
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    roomId: "",
    type: "OUT_OF_ORDER",
    reason: "",
    startDate: today,
    endDate: today,
  });
  const refresh = async (message: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["configuration", propertyId, "room-blocks"],
      }),
      queryClient.invalidateQueries({ queryKey: ["room-rack", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["configuration", propertyId, "rooms"] }),
      queryClient.invalidateQueries({ queryKey: ["housekeeping", propertyId] }),
      queryClient.invalidateQueries({ queryKey: ["settings", propertyId] }),
    ]);
    onMessage(message);
  };
  const create = useMutation({
    mutationFn: () =>
      api("/config/room-blocks", {
        method: "POST",
        body: { propertyId, ...form, reason: form.reason.trim() },
      }),
    onSuccess: () => {
      setForm((current) => ({ ...current, reason: "" }));
      void refresh("Room block created and inventory updated.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Room could not be blocked.",
        true,
      ),
  });
  const release = useMutation({
    mutationFn: (id: string) =>
      api(`/config/room-blocks/${id}/release`, { method: "POST", body: {} }),
    onSuccess: () => void refresh("Room block released through housekeeping."),
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Block could not be released.",
        true,
      ),
  });
  return (
    <div className="space-y-5">
      <Heading title="Room blocks" readOnly={!canManage} />
      {canManage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <select
            className={field}
            value={form.roomId}
            onChange={(event) =>
              setForm({ ...form, roomId: event.target.value })
            }
          >
            <option value="">Room…</option>
            {rooms.data?.map((room) => (
              <option key={room.id} value={room.id}>
                {room.roomNumber} · {room.roomType.code}
              </option>
            ))}
          </select>
          <select
            className={field}
            value={form.type}
            onChange={(event) => setForm({ ...form, type: event.target.value })}
          >
            <option value="OUT_OF_ORDER">Out of order</option>
            <option value="OUT_OF_SERVICE">Out of service</option>
            <option value="HOUSE_USE">House use</option>
          </select>
          <input
            className={field}
            placeholder="Reason"
            value={form.reason}
            onChange={(event) =>
              setForm({ ...form, reason: event.target.value })
            }
          />
          <input
            className={field}
            type="date"
            value={form.startDate}
            onChange={(event) =>
              setForm({ ...form, startDate: event.target.value })
            }
          />
          <input
            className={field}
            type="date"
            min={form.startDate}
            value={form.endDate}
            onChange={(event) =>
              setForm({ ...form, endDate: event.target.value })
            }
          />
          <button
            type="button"
            className={action}
            disabled={
              create.isPending ||
              !form.roomId ||
              form.reason.trim().length < 3 ||
              form.endDate < form.startDate
            }
            onClick={() => create.mutate()}
          >
            Block room
          </button>
        </div>
      ) : null}
      {blocks.isError ? <Empty>{blocks.error.message}</Empty> : null}
      {blocks.isPending ? <Empty>Loading room blocks…</Empty> : null}
      {blocks.data?.length ? (
        <div className="space-y-2">
          {blocks.data.map((block) => (
            <div
              key={block.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink/5 p-4 text-sm"
            >
              <div>
                <strong>
                  Room {block.room.roomNumber} ·{" "}
                  {block.type.replaceAll("_", " ")}
                </strong>
                <p className="text-xs text-ink/45">
                  {block.startDate} to {block.endDate} · {block.reason}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold">{block.status}</span>
                {canManage && block.status === "ACTIVE" ? (
                  <button
                    type="button"
                    disabled={release.isPending}
                    onClick={() => release.mutate(block.id)}
                    className="text-xs font-semibold text-brand-700"
                  >
                    Release
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : !blocks.isPending ? (
        <Empty>No room blocks recorded.</Empty>
      ) : null}
    </div>
  );
}

function Taxes({
  propertyId,
  canManage,
  rules,
  onMessage,
}: ChildProps & { rules: TaxRule[] }) {
  const queryClient = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({
    code: "VAT",
    name: "Value Added Tax",
    rate: "7.5",
    appliesTo: "ALL",
    basis: "EXCLUSIVE",
    effectiveFrom: today,
  });
  const save = useMutation({
    mutationFn: () =>
      api("/properties/tax-rules", {
        method: "POST",
        body: {
          propertyId,
          code: form.code.trim().toUpperCase(),
          name: form.name.trim(),
          rateBp: percentageToBasisPoints(form.rate),
          appliesTo: form.appliesTo,
          basis: form.basis,
          compoundOrder: 1,
          taxOnServiceCharge: true,
          effectiveFrom: form.effectiveFrom,
        },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["settings", propertyId],
      });
      onMessage("New tax version created; posted invoices remain unchanged.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error ? error.message : "Tax rule could not be saved.",
        true,
      ),
  });
  return (
    <div className="space-y-5">
      <Heading title="Versioned tax rules" readOnly={!canManage} />
      {canManage ? (
        <div className="grid gap-3 md:grid-cols-3">
          <input
            className={field}
            value={form.code}
            onChange={(event) => setForm({ ...form, code: event.target.value })}
            placeholder="Code"
          />
          <input
            className={field}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Name"
          />
          <input
            className={field}
            value={form.rate}
            onChange={(event) => setForm({ ...form, rate: event.target.value })}
            inputMode="decimal"
            placeholder="Rate %"
          />
          <select
            className={field}
            value={form.appliesTo}
            onChange={(event) =>
              setForm({ ...form, appliesTo: event.target.value })
            }
          >
            <option value="ALL">All charges</option>
            <option value="ROOM">Room</option>
            <option value="FB">Food & beverage</option>
          </select>
          <input
            className={field}
            type="date"
            value={form.effectiveFrom}
            onChange={(event) =>
              setForm({ ...form, effectiveFrom: event.target.value })
            }
          />
          <button
            type="button"
            className={action}
            disabled={
              save.isPending ||
              form.code.trim().length < 2 ||
              form.name.trim().length < 2
            }
            onClick={() => save.mutate()}
          >
            Create new version
          </button>
        </div>
      ) : null}
      {rules.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-ink/45">
                <th className="py-3">Code</th>
                <th>Name</th>
                <th>Rate</th>
                <th>Scope</th>
                <th>Version</th>
                <th>Effective</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-t border-ink/5">
                  <td className="py-3 font-mono">{rule.code}</td>
                  <td>{rule.name}</td>
                  <td>{(rule.rateBp / 100).toFixed(2)}%</td>
                  <td>{rule.appliesTo}</td>
                  <td>v{rule.version}</td>
                  <td>{rule.effectiveFrom}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No effective tax rules for the business date.</Empty>
      )}
    </div>
  );
}

function Team({
  propertyId,
  onMessage,
}: {
  propertyId: string;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ["memberships"],
    queryFn: () => api<Membership[]>("/memberships"),
  });
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api<Invitation[]>("/invitations?status=PENDING"),
  });
  const [form, setForm] = useState({
    email: "",
    fullName: "",
    role: "FRONT_DESK",
  });
  const invite = useMutation({
    mutationFn: () =>
      api("/invitations", {
        method: "POST",
        body: {
          email: form.email.trim().toLowerCase(),
          fullName: form.fullName.trim(),
          role: form.role,
          allProperties: false,
          propertyIds: [propertyId],
        },
      }),
    onSuccess: async () => {
      setForm({ email: "", fullName: "", role: "FRONT_DESK" });
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      onMessage("Invitation created and queued for delivery.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Invitation could not be created.",
        true,
      ),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, string> }) =>
      api(`/memberships/${id}`, { method: "PATCH", body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["memberships"] });
      onMessage("Team access updated; existing sessions were revoked safely.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Team access could not be updated.",
        true,
      ),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/invitations/${id}/revoke`, { method: "POST", body: {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      onMessage("Invitation revoked.");
    },
    onError: (error) =>
      onMessage(
        error instanceof Error
          ? error.message
          : "Invitation could not be revoked.",
        true,
      ),
  });
  return (
    <div className="space-y-6">
      <Heading title="Team and access" readOnly={false} />
      <div className="grid gap-3 md:grid-cols-4">
        <input
          className={field}
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <input
          className={field}
          placeholder="Full name"
          value={form.fullName}
          onChange={(event) =>
            setForm({ ...form, fullName: event.target.value })
          }
        />
        <select
          className={field}
          value={form.role}
          onChange={(event) => setForm({ ...form, role: event.target.value })}
        >
          {ROLES.map((role) => (
            <option key={role} value={role}>
              {role.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={action}
          disabled={
            invite.isPending ||
            !/^\S+@\S+\.\S+$/.test(form.email) ||
            form.fullName.trim().length < 2
          }
          onClick={() => invite.mutate()}
        >
          Invite user
        </button>
      </div>
      {members.isError ? <Empty>{members.error.message}</Empty> : null}
      {invitations.isError ? <Empty>{invitations.error.message}</Empty> : null}
      {members.isPending ? <Empty>Loading team…</Empty> : null}
      <div className="space-y-2">
        {members.data?.map((member) => (
          <div
            key={member.id}
            className="grid items-center gap-3 rounded-xl border border-ink/5 p-4 text-sm md:grid-cols-[1fr_190px_150px]"
          >
            <div>
              <strong>{member.user.fullName}</strong>
              <p className="text-xs text-ink/45">
                {member.user.email} ·{" "}
                {member.user.mfaEnabled ? "MFA enabled" : "MFA not enabled"}
              </p>
            </div>
            <select
              className={field}
              value={member.role}
              disabled={update.isPending}
              onChange={(event) =>
                update.mutate({
                  id: member.id,
                  body: { role: event.target.value },
                })
              }
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <select
              className={field}
              value={member.status}
              disabled={update.isPending}
              onChange={(event) =>
                update.mutate({
                  id: member.id,
                  body: { status: event.target.value },
                })
              }
            >
              <option value="ACTIVE">Active</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </div>
        ))}
      </div>
      {invitations.data?.length ? (
        <div>
          <h3 className="text-sm font-semibold">Pending invitations</h3>
          <div className="mt-2 space-y-2">
            {invitations.data.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between rounded-xl bg-cream p-3 text-sm"
              >
                <span>
                  {item.fullName} · {item.email} ·{" "}
                  {item.role.replaceAll("_", " ")}
                </span>
                <button
                  type="button"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(item.id)}
                  className="text-xs font-semibold text-red-700"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Heading({ title, readOnly }: { title: string; readOnly: boolean }) {
  return (
    <div>
      <h2 className="font-semibold">{title}</h2>
      {readOnly ? (
        <p className="mt-1 text-xs text-ink/45">
          Your role has read-only access.
        </p>
      ) : null}
    </div>
  );
}
