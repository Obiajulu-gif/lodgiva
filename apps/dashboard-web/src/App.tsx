import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, getSession, setSession } from "./api";
import { lastSyncAt, readQueue, startAutoSync, type SyncResult } from "./offline";
import LoginPage from "./pages/Login";
import OverviewPage from "./pages/Overview";
import RoomRackPage from "./pages/RoomRack";
import ReservationsPage from "./pages/Reservations";
import HousekeepingPage from "./pages/Housekeeping";
import PaymentsPage from "./pages/Payments";
import NightAuditPage from "./pages/NightAudit";
import PosPage from "./pages/Pos";
import CashieringPage from "./pages/Cashiering";
import MaintenancePage from "./pages/Maintenance";

export interface Me {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; displayName: string };
  role: string;
  properties: { id: string; name: string; code: string; businessDate: string }[];
}

/** §10.4 — the UI must show offline state, unsynced count and last sync. */
function SyncStatus() {
  const qc = useQueryClient();
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(readQueue().length);
  const [synced, setSynced] = useState(lastSyncAt());
  const [conflicts, setConflicts] = useState<string[]>([]);

  useEffect(() => {
    const refresh = () => setPending(readQueue().length);
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
          ...r.conflicts.map((c) => `${c.message}${c.resolution ? ` — ${c.resolution}` : ""}`),
          ...r.rejected.map((c) => c.message),
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
        {online ? "● Online" : "○ Offline — changes are queued"}
        {pending > 0 && <div>{pending} change{pending > 1 ? "s" : ""} waiting to sync</div>}
        {synced && <div>Last sync {new Date(synced).toLocaleTimeString()}</div>}
      </div>
      {conflicts.length > 0 && (
        <div
          onClick={() => setConflicts([])}
          style={{
            marginTop: 6, fontSize: 11, borderRadius: 10, padding: "8px 10px",
            background: "rgba(220,38,38,0.2)", color: "#fecaca", cursor: "pointer",
          }}
        >
          {conflicts.map((c, i) => <div key={i}>{c}</div>)}
          <div style={{ opacity: 0.7, marginTop: 4 }}>(tap to dismiss)</div>
        </div>
      )}
    </div>
  );
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
        <NavLink to="/rooms">Room Rack</NavLink>
        <NavLink to="/reservations">Reservations</NavLink>
        <NavLink to="/housekeeping">Housekeeping</NavLink>
        <NavLink to="/maintenance">Maintenance</NavLink>
        <NavLink to="/pos">POS</NavLink>
        <NavLink to="/payments">Payments</NavLink>
        <NavLink to="/cashiering">Cashiering</NavLink>
        <NavLink to="/night-audit">Night Audit</NavLink>
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
            <Route path="/rooms" element={<RoomRackPage propertyId={property.id} />} />
            <Route path="/reservations" element={<ReservationsPage propertyId={property.id} />} />
            <Route path="/housekeeping" element={<HousekeepingPage propertyId={property.id} />} />
            <Route path="/maintenance" element={<MaintenancePage propertyId={property.id} />} />
            <Route path="/pos" element={<PosPage propertyId={property.id} />} />
            <Route path="/payments" element={<PaymentsPage propertyId={property.id} />} />
            <Route path="/cashiering" element={<CashieringPage propertyId={property.id} />} />
            <Route path="/night-audit" element={<NightAuditPage propertyId={property.id} />} />
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
