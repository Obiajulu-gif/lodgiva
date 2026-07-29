import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, getSession, setSession } from "./api";
import LoginPage from "./pages/Login";
import OverviewPage from "./pages/Overview";
import RoomRackPage from "./pages/RoomRack";
import ReservationsPage from "./pages/Reservations";
import HousekeepingPage from "./pages/Housekeeping";
import PaymentsPage from "./pages/Payments";
import NightAuditPage from "./pages/NightAudit";

export interface Me {
  user: { id: string; email: string; fullName: string };
  tenant: { id: string; displayName: string };
  role: string;
  properties: { id: string; name: string; code: string; businessDate: string }[];
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
        <NavLink to="/payments">Payments</NavLink>
        <NavLink to="/night-audit">Night Audit</NavLink>
        <div className="spacer" />
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
            <Route path="/payments" element={<PaymentsPage propertyId={property.id} />} />
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
