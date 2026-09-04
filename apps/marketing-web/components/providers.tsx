"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ApiError,
  api,
  getSession,
  refreshSession,
  setSession,
  setSessionExpiredHandler,
} from "@/lib/api/client";
import type { Me, Session } from "@/lib/api/types";

type AuthStatus = "loading" | "authenticated" | "anonymous";

interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  selectedPropertyId: string;
  setSelectedPropertyId: (propertyId: string) => void;
  completeSignIn: (session: Session) => Promise<void>;
  retrySession: () => Promise<void>;
  logout: () => Promise<void>;
  error: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        retry: (attempt, error) =>
          !(error instanceof ApiError && error.status < 500) && attempt < 2,
      },
      mutations: { retry: false },
    },
  });
}

function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [selectedPropertyId, selectProperty] = useState("");
  const [error, setError] = useState("");

  const loadMe = useCallback(async () => {
    const profile = await api<Me>("/auth/me");
    setMe(profile);
    selectProperty((current) =>
      profile.properties.some((property) => property.id === current)
        ? current
        : (profile.properties[0]?.id ?? ""),
    );
    setStatus("authenticated");
    setError("");
  }, []);

  const retrySession = useCallback(async () => {
    setStatus("loading");
    setError("");
    let restored = getSession();
    try {
      restored = restored ?? (await refreshSession());
      if (!restored) {
        setStatus("anonymous");
        setMe(null);
        return;
      }
      await loadMe();
    } catch (cause) {
      setStatus(restored ? "authenticated" : "anonymous");
      setMe(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Your workspace could not be loaded.",
      );
    }
  }, [loadMe]);

  useEffect(() => {
    void retrySession();
  }, [retrySession]);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setStatus("anonymous");
      setMe(null);
      if (pathname.startsWith("/dashboard"))
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    });
    return () => setSessionExpiredHandler(null);
  }, [pathname, router]);

  const completeSignIn = useCallback(
    async (nextSession: Session) => {
      setSession(nextSession);
      setStatus("loading");
      await loadMe();
    },
    [loadMe],
  );

  const logout = useCallback(async () => {
    if (getSession())
      await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setSession(null);
    setMe(null);
    setStatus("anonymous");
    router.replace("/login");
  }, [router]);

  return (
    <AuthContext.Provider
      value={{
        status,
        me,
        selectedPropertyId,
        setSelectedPropertyId: selectProperty,
        completeSignIn,
        retrySession,
        logout,
        error,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside Providers");
  return value;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
