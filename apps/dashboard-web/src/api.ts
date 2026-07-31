// Typed-ish fetch client for the Lodgiva API with refresh-token rotation.

import { isCacheable, readCache, writeCache } from "./cache";

const BASE = "/api/v1";

/** Set when the last successful read came from the offline cache. */
export interface StaleInfo {
  fromCache: boolean;
  cachedAt?: number;
}
const staleness = new Map<string, StaleInfo>();

export function stalenessFor(path: string): StaleInfo {
  return staleness.get(path) ?? { fromCache: false };
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  claims: { userId: string; email: string; tenantId: string; role: string };
}

export function getSession(): Session | null {
  const raw = localStorage.getItem("lodgiva.session");
  return raw ? (JSON.parse(raw) as Session) : null;
}

export function setSession(s: Session | null) {
  if (s) localStorage.setItem("lodgiva.session", JSON.stringify(s));
  else localStorage.removeItem("lodgiva.session");
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown
  ) {
    super(message);
  }
}

async function refresh(): Promise<Session | null> {
  const session = getSession();
  if (!session) return null;
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    setSession(null);
    return null;
  }
  const next = (await res.json()) as Session;
  setSession(next);
  return next;
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  retried = false
): Promise<T> {
  const isRead = (options.method ?? "GET") === "GET";
  const session = getSession();

  // Known-offline reads go straight to the cache rather than waiting for a
  // request that cannot succeed.
  if (isRead && !navigator.onLine && isCacheable(path)) {
    const cached = await readCache<T>(path);
    if (cached) {
      staleness.set(path, { fromCache: true, cachedAt: cached.cachedAt });
      return cached.data;
    }
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    // The server was unreachable. For a cacheable read, serving a labelled
    // stale copy beats an error screen for someone standing in a corridor.
    if (isRead && isCacheable(path)) {
      const cached = await readCache<T>(path);
      if (cached) {
        staleness.set(path, { fromCache: true, cachedAt: cached.cachedAt });
        return cached.data;
      }
    }
    throw err;
  }
  if (res.status === 401 && !retried) {
    const next = await refresh();
    if (next) return api<T>(path, options, true);
    window.location.href = "/login";
    throw new ApiError("UNAUTHENTICATED", "Session expired", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && isRead && isCacheable(path)) {
    // Populate the offline copy on every successful read, so the cache is
    // warm from ordinary use rather than needing a separate sync step.
    staleness.set(path, { fromCache: false });
    void writeCache(path, data);
  }
  if (!res.ok && isRead && res.status >= 500 && isCacheable(path)) {
    const cached = await readCache<T>(path);
    if (cached) {
      staleness.set(path, { fromCache: true, cachedAt: cached.cachedAt });
      return cached.data;
    }
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; details?: unknown } }).error;
    throw new ApiError(
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.details
    );
  }
  return data as T;
}

export const naira = (minor: number) =>
  `₦${(minor / 100).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
