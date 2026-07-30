import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, naira } from "../api";

/**
 * Property configuration CRUD.
 *
 * Read is open to any authenticated member; every write is gated on a
 * permission, and the UI hides controls the signed-in role cannot use rather
 * than letting the user discover the 403 by clicking.
 */

interface Me {
  role: string;
  permissions: string[];
}
interface Property {
  id: string; name: string; code: string; timezone: string;
  businessDate: string; checkinTime: string; checkoutTime: string; status: string;
}
interface TaxRule {
  id: string; code: string; name: string; rateBp: number; version: number;
  appliesTo: string; basis: string; compoundOrder: number; effectiveFrom: string;
}
interface SettingsPayload {
  property: Property;
  counts: { roomTypes: number; rooms: number; amenities: number; activeBlocks: number };
  effectiveTaxRules: TaxRule[];
}
interface Amenity { id: string; code: string; name: string; category: string }
interface RoomType {
  id: string; code: string; name: string; baseRateMinor: number;
  baseOccupancy: number; maxOccupancy: number;
  amenities: { amenity: Amenity }[];
  _count: { rooms: number };
}
interface Room {
  id: string; roomNumber: string; floor: number; operationalStatus: string;
  roomType: { id: string; code: string; name: string };
  blocks: { id: string; type: string; startDate: string; endDate: string }[];
}
interface RoomBlock {
  id: string; type: string; reason: string; startDate: string; endDate: string;
  status: string; room: { roomNumber: string };
}

const TABS = ["Property", "Room types", "Rooms", "Amenities", "Blocks", "Taxes"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("Property");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/auth/me") });
  const can = (p: string) => !!me?.permissions?.includes(p);

  const { data: settings } = useQuery({
    queryKey: ["settings", propertyId],
    queryFn: () => api<SettingsPayload>(`/properties/${propertyId}/settings`),
  });

  const onError = (e: unknown) =>
    setError(e instanceof ApiError ? `${e.message}` : String(e));
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["settings", propertyId] });
    qc.invalidateQueries({ queryKey: ["cfg", propertyId] });
    qc.invalidateQueries({ queryKey: ["room-rack", propertyId] });
  };
  const ok = (msg: string) => { setNotice(msg); setError(""); invalidate(); };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Property Settings</h1>
          <p className="sub">
            {settings?.property.name} · {settings?.counts.rooms ?? 0} rooms ·{" "}
            {settings?.counts.roomTypes ?? 0} room types
            {!can("settings.room.manage") && " · read-only for your role"}
          </p>
        </div>
        <span className="badge">{me?.role?.replace("_", " ")}</span>
      </div>

      {error && <div className="error-box" onClick={() => setError("")}>{error} (tap to dismiss)</div>}
      {notice && !error && (
        <div className="card" style={{ background: "var(--brand-50)", padding: 12, marginBottom: 16, fontSize: 13 }}>
          {notice}
        </div>
      )}

      <div className="toolbar">
        {TABS.map((t) => (
          <button
            key={t}
            className={tab === t ? "" : "secondary"}
            onClick={() => { setTab(t); setNotice(""); setError(""); }}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Property" && (
        <PropertyTab settings={settings} canManage={can("settings.property.manage")} onOk={ok} onError={onError} propertyId={propertyId} />
      )}
      {tab === "Room types" && (
        <RoomTypesTab propertyId={propertyId} canManage={can("settings.room.manage")} onOk={ok} onError={onError} />
      )}
      {tab === "Rooms" && (
        <RoomsTab propertyId={propertyId} canManage={can("settings.room.manage")} onOk={ok} onError={onError} />
      )}
      {tab === "Amenities" && (
        <AmenitiesTab propertyId={propertyId} canManage={can("settings.room.manage")} onOk={ok} onError={onError} />
      )}
      {tab === "Blocks" && (
        <BlocksTab propertyId={propertyId} canManage={can("room.block")} onOk={ok} onError={onError} />
      )}
      {tab === "Taxes" && (
        <TaxesTab propertyId={propertyId} rules={settings?.effectiveTaxRules ?? []} canManage={can("settings.tax.manage")} onOk={ok} onError={onError} />
      )}
    </>
  );
}

type TabProps = {
  propertyId: string;
  canManage: boolean;
  onOk: (m: string) => void;
  onError: (e: unknown) => void;
};

function PropertyTab({
  settings, canManage, onOk, onError, propertyId,
}: { settings?: SettingsPayload } & TabProps) {
  const [form, setForm] = useState<Partial<Property>>({});
  const p = settings?.property;
  const value = <K extends keyof Property>(k: K) => (form[k] ?? p?.[k] ?? "") as string;

  const save = useMutation({
    mutationFn: () =>
      api(`/properties/${propertyId}/settings`, { method: "PATCH", body: form }),
    onSuccess: () => { setForm({}); onOk("Property settings saved."); },
    onError,
  });

  if (!p) return null;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3>Profile</h3>
        <div className="field">
          <label>NAME</label>
          <input disabled={!canManage} value={value("name")} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="row field">
          <div>
            <label>CODE</label>
            <input value={p.code} disabled title="The property code is immutable once created" />
          </div>
          <div>
            <label>TIMEZONE</label>
            <input disabled={!canManage} value={value("timezone")} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          </div>
        </div>
        <div className="row field">
          <div>
            <label>CHECK-IN</label>
            <input disabled={!canManage} value={value("checkinTime")} placeholder="14:00"
              onChange={(e) => setForm({ ...form, checkinTime: e.target.value })} />
          </div>
          <div>
            <label>CHECK-OUT</label>
            <input disabled={!canManage} value={value("checkoutTime")} placeholder="12:00"
              onChange={(e) => setForm({ ...form, checkoutTime: e.target.value })} />
          </div>
        </div>
        {canManage && (
          <button disabled={!Object.keys(form).length || save.isPending} onClick={() => save.mutate()}>
            Save changes
          </button>
        )}
      </div>

      <div className="card">
        <h3>Business date</h3>
        <p style={{ fontSize: 26, fontWeight: 700 }}>{p.businessDate}</p>
        <p className="hint">
          The business date advances <b>only</b> through night audit. It is not
          editable here by design — moving it by hand would skip a day of room
          posting and break revenue continuity.
        </p>
        <div className="mt" style={{ display: "grid", gap: 8 }}>
          {[
            ["Room types", settings.counts.roomTypes],
            ["Rooms", settings.counts.rooms],
            ["Amenities", settings.counts.amenities],
            ["Active blocks", settings.counts.activeBlocks],
          ].map(([label, n]) => (
            <div key={String(label)} style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span style={{ color: "var(--ink-50)" }}>{label}</span>
              <b>{n}</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RoomTypesTab({ propertyId, canManage, onOk, onError }: TabProps) {
  const [form, setForm] = useState({ code: "", name: "", baseRateMinor: "", baseOccupancy: "2", maxOccupancy: "2" });
  const { data } = useQuery({
    queryKey: ["cfg", propertyId, "room-types"],
    queryFn: () => api<RoomType[]>(`/config/room-types?propertyId=${propertyId}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/config/room-types", {
        method: "POST",
        body: {
          propertyId,
          code: form.code,
          name: form.name,
          baseRateMinor: Math.round(Number(form.baseRateMinor) * 100),
          baseOccupancy: Number(form.baseOccupancy),
          maxOccupancy: Number(form.maxOccupancy),
        },
      }),
    onSuccess: () => { setForm({ code: "", name: "", baseRateMinor: "", baseOccupancy: "2", maxOccupancy: "2" }); onOk("Room type created."); },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/config/room-types/${id}`, { method: "DELETE" }),
    onSuccess: () => onOk("Room type deleted."),
    onError,
  });

  return (
    <>
      {canManage && (
        <div className="card">
          <h3>Add a room type</h3>
          <div className="row">
            <div><label>CODE</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="DLX" /></div>
            <div><label>NAME</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Deluxe" /></div>
            <div><label>RATE (₦/night)</label><input value={form.baseRateMinor} onChange={(e) => setForm({ ...form, baseRateMinor: e.target.value })} inputMode="numeric" /></div>
            <div><label>SLEEPS</label><input value={form.maxOccupancy} onChange={(e) => setForm({ ...form, maxOccupancy: e.target.value })} inputMode="numeric" /></div>
          </div>
          <button className="mt" disabled={!form.code || !form.name || !form.baseRateMinor || create.isPending} onClick={() => create.mutate()}>
            Create room type
          </button>
        </div>
      )}

      <div className="card mt">
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Rate</th><th>Sleeps</th><th>Rooms</th><th>Amenities</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((t) => (
              <tr key={t.id}>
                <td style={{ fontFamily: "monospace" }}>{t.code}</td>
                <td>{t.name}</td>
                <td>{naira(t.baseRateMinor)}</td>
                <td>{t.maxOccupancy}</td>
                <td>{t._count.rooms}</td>
                <td style={{ fontSize: 11, color: "var(--ink-50)" }}>
                  {t.amenities.map((a) => a.amenity.code).join(", ") || "—"}
                </td>
                <td>
                  {canManage && (
                    <button className="small secondary" onClick={() => remove.mutate(t.id)}
                      title={t._count.rooms > 0 ? "Room types with rooms cannot be deleted" : "Delete"}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>No room types yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RoomsTab({ propertyId, canManage, onOk, onError }: TabProps) {
  const [form, setForm] = useState({ roomTypeId: "", roomNumber: "", floor: "1" });
  const [csv, setCsv] = useState("room_number,room_type_code,floor\n");
  const [preview, setPreview] = useState<string>("");

  const { data: types } = useQuery({
    queryKey: ["cfg", propertyId, "room-types"],
    queryFn: () => api<RoomType[]>(`/config/room-types?propertyId=${propertyId}`),
  });
  const { data: rooms } = useQuery({
    queryKey: ["cfg", propertyId, "rooms"],
    queryFn: () => api<Room[]>(`/config/rooms?propertyId=${propertyId}`),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/config/rooms", {
        method: "POST",
        body: { propertyId, roomTypeId: form.roomTypeId, roomNumber: form.roomNumber, floor: Number(form.floor) },
      }),
    onSuccess: () => { setForm({ ...form, roomNumber: "" }); onOk("Room created."); },
    onError,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/config/rooms/${id}`, { method: "DELETE" }),
    onSuccess: () => onOk("Room deleted."),
    onError,
  });

  const importRooms = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<{ dryRun: boolean; created?: number; wouldCreate?: number; rooms: string[] }>(
        "/config/imports/rooms",
        { method: "POST", body: { propertyId, csv, dryRun } }
      ),
    onSuccess: (r) => {
      if (r.dryRun) setPreview(`Dry run: ${r.wouldCreate} room(s) would be created — ${r.rooms.join(", ")}`);
      else { setPreview(""); onOk(`Imported ${r.created} room(s).`); }
    },
    onError: (e) => { setPreview(""); onError(e); },
  });

  return (
    <>
      {canManage && (
        <div className="grid cols-2">
          <div className="card">
            <h3>Add a room</h3>
            <div className="row">
              <div>
                <label>ROOM TYPE</label>
                <select value={form.roomTypeId} onChange={(e) => setForm({ ...form, roomTypeId: e.target.value })}>
                  <option value="">Select…</option>
                  {(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
                </select>
              </div>
              <div><label>NUMBER</label><input value={form.roomNumber} onChange={(e) => setForm({ ...form, roomNumber: e.target.value })} /></div>
              <div><label>FLOOR</label><input value={form.floor} onChange={(e) => setForm({ ...form, floor: e.target.value })} inputMode="numeric" /></div>
            </div>
            <button className="mt" disabled={!form.roomTypeId || !form.roomNumber || create.isPending} onClick={() => create.mutate()}>
              Create room
            </button>
          </div>

          <div className="card">
            <h3>Bulk import</h3>
            <p className="hint" style={{ marginTop: 0 }}>
              Columns: <code>room_number, room_type_code, floor</code>. The whole
              file is validated before anything is written.
            </p>
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={5}
              style={{
                width: "100%", fontFamily: "monospace", fontSize: 12, padding: 10,
                border: "1px solid var(--border)", borderRadius: 10, resize: "vertical",
              }}
            />
            <div className="row mt">
              <button className="secondary" disabled={importRooms.isPending} onClick={() => importRooms.mutate(true)}>
                Dry run
              </button>
              <button disabled={importRooms.isPending} onClick={() => importRooms.mutate(false)}>
                Import
              </button>
            </div>
            {preview && <p className="hint">{preview}</p>}
          </div>
        </div>
      )}

      <div className="card mt">
        <table>
          <thead><tr><th>Room</th><th>Type</th><th>Floor</th><th>Status</th><th>Blocks</th><th /></tr></thead>
          <tbody>
            {(rooms ?? []).map((r) => (
              <tr key={r.id}>
                <td><b>{r.roomNumber}</b></td>
                <td>{r.roomType.code}</td>
                <td>{r.floor}</td>
                <td><span className={`pill ${r.operationalStatus.startsWith("OCCUPIED") ? "green" : r.operationalStatus.includes("DIRTY") ? "gold" : r.operationalStatus.startsWith("OUT") ? "red" : "blue"}`}>
                  {r.operationalStatus.replace(/_/g, " ")}
                </span></td>
                <td>{r.blocks.length || "—"}</td>
                <td>{canManage && <button className="small secondary" onClick={() => remove.mutate(r.id)}>Delete</button>}</td>
              </tr>
            ))}
            {!rooms?.length && <tr><td colSpan={6} style={{ color: "var(--ink-50)" }}>No rooms yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AmenitiesTab({ propertyId, canManage, onOk, onError }: TabProps) {
  const [form, setForm] = useState({ code: "", name: "", category: "ROOM" });
  const { data } = useQuery({
    queryKey: ["cfg", propertyId, "amenities"],
    queryFn: () => api<Amenity[]>(`/config/amenities?propertyId=${propertyId}`),
  });

  const create = useMutation({
    mutationFn: () => api("/config/amenities", { method: "POST", body: { propertyId, ...form } }),
    onSuccess: () => { setForm({ code: "", name: "", category: "ROOM" }); onOk("Amenity created."); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/config/amenities/${id}`, { method: "DELETE" }),
    onSuccess: () => onOk("Amenity deleted."),
    onError,
  });

  return (
    <>
      {canManage && (
        <div className="card">
          <h3>Add an amenity</h3>
          <div className="row">
            <div><label>CODE</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="WIFI" /></div>
            <div><label>NAME</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Fast Wi-Fi" /></div>
            <div>
              <label>CATEGORY</label>
              <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {["ROOM", "BATHROOM", "TECH", "ACCESSIBILITY", "PROPERTY"].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <button className="mt" disabled={!form.code || !form.name || create.isPending} onClick={() => create.mutate()}>
            Create amenity
          </button>
        </div>
      )}
      <div className="card mt">
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Category</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}>
                <td style={{ fontFamily: "monospace" }}>{a.code}</td>
                <td>{a.name}</td>
                <td><span className="pill blue">{a.category}</span></td>
                <td>{canManage && <button className="small secondary" onClick={() => remove.mutate(a.id)}>Delete</button>}</td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={4} style={{ color: "var(--ink-50)" }}>No amenities yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BlocksTab({ propertyId, canManage, onOk, onError }: TabProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ roomId: "", type: "OUT_OF_ORDER", reason: "", startDate: today, endDate: today });

  const { data: rooms } = useQuery({
    queryKey: ["cfg", propertyId, "rooms"],
    queryFn: () => api<Room[]>(`/config/rooms?propertyId=${propertyId}`),
  });
  const { data: blocks } = useQuery({
    queryKey: ["cfg", propertyId, "blocks"],
    queryFn: () => api<RoomBlock[]>(`/config/room-blocks?propertyId=${propertyId}&status=ALL`),
  });

  const create = useMutation({
    mutationFn: () => api("/config/room-blocks", { method: "POST", body: { propertyId, ...form } }),
    onSuccess: () => { setForm({ ...form, reason: "" }); onOk("Room blocked."); },
    onError,
  });
  const release = useMutation({
    mutationFn: (id: string) => api(`/config/room-blocks/${id}/release`, { method: "POST", body: {} }),
    onSuccess: () => onOk("Block released — the room returns through housekeeping."),
    onError,
  });

  return (
    <>
      {canManage && (
        <div className="card">
          <h3>Block a room</h3>
          <div className="row">
            <div>
              <label>ROOM</label>
              <select value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
                <option value="">Select…</option>
                {(rooms ?? []).map((r) => <option key={r.id} value={r.id}>{r.roomNumber} ({r.roomType.code})</option>)}
              </select>
            </div>
            <div>
              <label>TYPE</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                <option value="OUT_OF_ORDER">Out of order</option>
                <option value="OUT_OF_SERVICE">Out of service</option>
                <option value="HOUSE_USE">House use</option>
              </select>
            </div>
            <div><label>FROM</label><input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></div>
            <div><label>TO</label><input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></div>
          </div>
          <div className="field mt">
            <label>REASON</label>
            <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Bathroom refit" />
          </div>
          <button disabled={!form.roomId || form.reason.length < 3 || create.isPending} onClick={() => create.mutate()}>
            Block room
          </button>
          <p className="hint">
            Blocked nights are removed from sellable inventory. A block cannot be
            placed over an existing booking.
          </p>
        </div>
      )}
      <div className="card mt">
        <table>
          <thead><tr><th>Room</th><th>Type</th><th>Reason</th><th>From</th><th>To</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(blocks ?? []).map((b) => (
              <tr key={b.id}>
                <td><b>{b.room.roomNumber}</b></td>
                <td>{b.type.replace(/_/g, " ")}</td>
                <td>{b.reason}</td>
                <td>{b.startDate}</td>
                <td>{b.endDate}</td>
                <td><span className={`pill ${b.status === "ACTIVE" ? "red" : "gray"}`}>{b.status}</span></td>
                <td>{canManage && b.status === "ACTIVE" && (
                  <button className="small secondary" onClick={() => release.mutate(b.id)}>Release</button>
                )}</td>
              </tr>
            ))}
            {!blocks?.length && <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>No blocks.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function TaxesTab({
  propertyId, rules, canManage, onOk, onError,
}: { rules: TaxRule[] } & TabProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [form, setForm] = useState({ code: "VAT", name: "Value Added Tax", ratePct: "7.5", compoundOrder: "2", taxOnServiceCharge: true, effectiveFrom: today });

  const save = useMutation({
    mutationFn: () =>
      api("/properties/tax-rules", {
        method: "POST",
        body: {
          propertyId,
          code: form.code,
          name: form.name,
          rateBp: Math.round(Number(form.ratePct) * 100),
          compoundOrder: Number(form.compoundOrder),
          taxOnServiceCharge: form.taxOnServiceCharge,
          effectiveFrom: form.effectiveFrom,
        },
      }),
    onSuccess: () => onOk("New tax rule version created. Existing invoices are unchanged."),
    onError,
  });

  return (
    <>
      <div className="card">
        <h3>Effective tax rules</h3>
        <table>
          <thead><tr><th>Code</th><th>Name</th><th>Rate</th><th>Version</th><th>Applies to</th><th>Basis</th><th>From</th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
                <td style={{ fontFamily: "monospace" }}>{r.code}</td>
                <td>{r.name}</td>
                <td><b>{(r.rateBp / 100).toFixed(2)}%</b></td>
                <td>v{r.version}</td>
                <td>{r.appliesTo}</td>
                <td>{r.basis}</td>
                <td>{r.effectiveFrom}</td>
              </tr>
            ))}
            {!rules.length && <tr><td colSpan={7} style={{ color: "var(--ink-50)" }}>Using platform defaults (5% service, 7.5% VAT).</td></tr>}
          </tbody>
        </table>
      </div>

      {canManage ? (
        <div className="card mt">
          <h3>Change a rate</h3>
          <p className="hint" style={{ marginTop: 0 }}>
            Changing a rate creates a <b>new version</b> from the effective date.
            Invoices already posted keep the version they were billed under and
            never change.
          </p>
          <div className="row">
            <div><label>CODE</label><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></div>
            <div><label>NAME</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>RATE (%)</label><input value={form.ratePct} onChange={(e) => setForm({ ...form, ratePct: e.target.value })} inputMode="decimal" /></div>
            <div><label>EFFECTIVE FROM</label><input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></div>
          </div>
          <button className="mt" disabled={save.isPending} onClick={() => save.mutate()}>
            Create new version
          </button>
        </div>
      ) : (
        <p className="hint">
          Tax configuration is restricted to owner and finance roles.
        </p>
      )}
    </>
  );
}
