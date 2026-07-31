import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getSession, setSession } from "./api";
import { lastSyncAt, readQueue, startAutoSync, flush, type SyncResult } from "./offline";
import { getSession as sessionForStream } from "./api";
import LoginPage from "./pages/Login";
import OverviewPage from "./pages/Overview";
import RoomRackPage from "./pages/RoomRack";
import RoomBoardPage from "./pages/RoomBoard";
import ReservationsPage from "./pages/Reservations";
import CalendarPage from "./pages/Calendar";
import HousekeepingPage from "./pages/Housekeeping";
import PaymentsPage from "./pages/Payments";
import NightAuditPage from "./pages/NightAudit";
import PosPage from "./pages/Pos";
import CashieringPage from "./pages/Cashiering";
import MaintenancePage from "./pages/Maintenance";
import SettingsPage from "./pages/Settings";

export interface Me {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; displayName: string };
  role: string;
  properties: { id: string; name: string; code: string; businessDate: string }[];
}

/** §10.4 — the UI must show offline state, unsynced count and last sync. */
/**
 * Live updates.
 *
 * The stream carries change notifications only; the app re-reads through the
 * normal endpoints, so permissions are enforced in exactly one place. If the
 * stream cannot be established the app is not broken — the existing polling
 * intervals still refresh it, just less promptly.
 */
function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const session = sessionForStream();
    if (!session) return;

    const es = new EventSource(
      `/api/v1/events/stream?token=${encodeURIComponent(session.accessToken)}`
    );
    es.addEventListener("ready", () => setLive(true));
    es.addEventListener("change", () => {
      // Refetch rather than patching from the payload: the server decides
      // what this user may see.
      qc.invalidateQueries();
    });
    es.onerror = () => setLive(false);
    return () => {
      es.close();
      setLive(false);
    };
  }, [enabled, qc]);

  return live;
}

function SyncStatus() {
  const qc = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(readQueue().length);
  const [synced, setSynced] = useState(lastSyncAt());
  const [conflicts, setConflicts] = useState<{ message: string; resolution?: string }[]>([]);
  const live = useLiveUpdates(true);
  const [flushing, setFlushing] = useState(false);
  const refresh = () => setPending(readQueue().length);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("lodgiva:queue", refresh);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);

    const stop = startAutoSync((r: SyncResult) => {
      refresh();
      setSynced(lastSyncAt());
      if (r.conflicts.length || r.rejected.length) {
        setConflicts([
          ...r.conflicts.map((c) => ({ message: c.message, resolution: c.resolution })),
          ...r.rejected.map((c) => ({ message: c.message })),
        ]);
      }
      if (r.applied.length || r.serverChanges.length) qc.invalidateQueries();
    });
    return () => {
      window.removeEventListener("lodgiva:queue", refresh);
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      stop();
    };
  }, [qc]);

  return (
    <div style={{ padding: "0 12px 10px" }}>
      <div
        style={{
          fontSize: 11,
          borderRadius: 10,
          padding: "8px 10px",
          background: online ? "rgba(255,255,255,0.06)" : "rgba(205,169,92,0.18)",
          color: online ? "rgba(255,255,255,0.65)" : "#eddfb9",
        }}
      >
        {online ? (live ? "● Live" : "● Online") : "○ Offline — changes are queued"}
        {pending > 0 && (
          <div>
            {pending} change{pending > 1 ? "s" : ""} waiting to sync
          </div>
        )}
        {synced && <div>Last sync {new Date(synced).toLocaleTimeString()}</div>}
        {online && pending > 0 && (
          <button
            className="small"
            style={{ marginTop: 6, padding: "4px 10px", fontSize: 11 }}
            disabled={flushing}
            onClick={async () => {
              setFlushing(true);
              const r = await flush();
              setFlushing(false);
              refresh();
              setSynced(lastSyncAt());
              if (r && (r.conflicts.length || r.rejected.length)) {
                setConflicts([
                  ...r.conflicts.map((c) => ({ message: c.message, resolution: c.resolution })),
                  ...r.rejected.map((c) => ({ message: c.message })),
                ]);
              }
            }}
          >
            {flushing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>
      {conflicts.length > 0 && (
        <div
          onClick={() => setConflicts([])}
          style={{
            marginTop: 6, fontSize: 11, borderRadius: 10, padding: "8px 10px",
            background: "rgba(220,38,38,0.2)", color: "#fecaca", cursor: "pointer",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>
            {conflicts.length} change{conflicts.length > 1 ? "s" : ""} could not be applied
          </div>
          {conflicts.map((c, i) => (
            <div key={i} style={{ marginBottom: 6 }}>
              <div>{c.message}</div>
              {/* The server proposes what to do; guessing on the device would
                  risk silently overwriting somebody else's work. */}
              {c.resolution && (
                <div style={{ opacity: 0.85, fontStyle: "italic" }}>→ {c.resolution}</div>
              )}
            </div>
          ))}
          <div style={{ opacity: 0.7, marginTop: 4 }}>(tap to dismiss)</div>
        </div>
      )}
    </div>
  );
}


/**
 * Route-level permissions.
 *
 * The API is the real boundary — every endpoint is guarded server-side. This
 * mirrors those rules in the UI so a housekeeper is not shown a Cashiering tab
 * that would only ever return 403. Hiding a route is a usability decision, not
 * a security one.
 */
const ROUTE_ROLES: Record<string, string[] | null> = {
  "/": null,
  "/board": null,
  "/rooms": null,
  "/reservations": ["TENANT_OWNER", "GENERAL_MANAGER", "FRONT_DESK", "CASHIER"],
  "/calendar": ["TENANT_OWNER", "GENERAL_MANAGER", "FRONT_DESK", "CASHIER"],
  "/housekeeping": null,
  "/maintenance": null,
  "/pos": ["TENANT_OWNER", "GENERAL_MANAGER", "FRONT_DESK", "CASHIER"],
  "/payments": ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE", "CASHIER", "FRONT_DESK"],
  "/cashiering": ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE", "CASHIER"],
  "/night-audit": ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"],
  "/settings": ["TENANT_OWNER", "GENERAL_MANAGER", "FINANCE"],
};

export function canAccess(path: string, role?: string): boolean {
  const allowed = ROUTE_ROLES[path];
  if (allowed === null || allowed === undefined) return true;
  return !!role && allowed.includes(role);
}

/** Inspection is a supervisory step, not something a cleaner signs off. */
export function canInspect(role?: string): boolean {
  return ["TENANT_OWNER", "GENERAL_MANAGER"].includes(role ?? "");
}

function Shell() {
  const navigate = useNavigate();
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<Me>("/auth/me"),
  });
  const property = me?.properties[0];

  const logout = async () => {
    const s = getSession();
    if (s) await api("/auth/logout", { method: "POST", body: { refreshToken: s.refreshToken } }).catch(() => {});
    setSession(null);
    navigate("/login");
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <img src="/icon.svg" alt="" /> Lodgiva
        </div>
        <div className="prop">
          PROPERTY
          <b>{property?.name ?? "…"}</b>
          Business date: {property?.businessDate ?? "…"}
        </div>
        <NavLink to="/" end>Overview</NavLink>
        <NavLink to="/board">Room Board</NavLink>
        <NavLink to="/rooms">Room Rack</NavLink>
        {canAccess("/reservations", me?.role) && <NavLink to="/reservations">Reservations</NavLink>}
        {canAccess("/calendar", me?.role) && <NavLink to="/calendar">Calendar</NavLink>}
        <NavLink to="/housekeeping">Housekeeping</NavLink>
        <NavLink to="/maintenance">Maintenance</NavLink>
        {canAccess("/pos", me?.role) && <NavLink to="/pos">POS</NavLink>}
        {canAccess("/payments", me?.role) && <NavLink to="/payments">Payments</NavLink>}
        {canAccess("/cashiering", me?.role) && <NavLink to="/cashiering">Cashiering</NavLink>}
        {canAccess("/night-audit", me?.role) && <NavLink to="/night-audit">Night Audit</NavLink>}
        {canAccess("/settings", me?.role) && <NavLink to="/settings">Settings</NavLink>}
        <div className="spacer" />
        <SyncStatus />
        <a href="#logout" onClick={(e) => { e.preventDefault(); logout(); }}>
          Sign out {me ? `(${me.user.fullName.split(" ")[0]})` : ""}
        </a>
      </nav>
      <main className="main">
        {property && (
          <Routes>
            <Route path="/" element={<OverviewPage propertyId={property.id} />} />
            <Route path="/board" element={<RoomBoardPage propertyId={property.id} canInspect={canInspect(me?.role)} />} />
            <Route path="/rooms" element={<RoomRackPage propertyId={property.id} />} />
            <Route path="/reservations" element={<ReservationsPage propertyId={property.id} />} />
            <Route path="/calendar" element={<CalendarPage propertyId={property.id} />} />
            <Route path="/housekeeping" element={<HousekeepingPage propertyId={property.id} />} />
            <Route path="/maintenance" element={<MaintenancePage propertyId={property.id} />} />
            <Route path="/pos" element={<PosPage propertyId={property.id} />} />
            <Route path="/payments" element={<PaymentsPage propertyId={property.id} />} />
            <Route path="/cashiering" element={<CashieringPage propertyId={property.id} />} />
            <Route path="/night-audit" element={<NightAuditPage propertyId={property.id} />} />
            <Route path="/settings" element={<SettingsPage propertyId={property.id} />} />
          </Routes>
        )}
      </main>
    </div>
  );
}

function RequireAuth() {
  // Evaluated on every navigation — this component is the routed element.
  return getSession() ? <Shell /> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<RequireAuth />} />
    </Routes>
  );
}
