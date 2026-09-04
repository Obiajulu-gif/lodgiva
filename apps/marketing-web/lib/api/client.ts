import type { Session } from "./types";

const API_BASE = "/api/v1";
let session: Session | null = null;
let refreshInFlight: Promise<Session | null> | null = null;
let onSessionExpired: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getSession() {
  return session;
}

export function setSession(next: Session | null) {
  session = next;
}

export function setSessionExpiredHandler(handler: (() => void) | null) {
  onSessionExpired = handler;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = data as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    throw new ApiError(
      problem.error?.code ?? "REQUEST_FAILED",
      problem.error?.message ?? `Request failed (${response.status})`,
      response.status,
      problem.error?.details,
    );
  }
  return data as T;
}

export async function authPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/auth/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseResponse<T>(response);
}

export async function refreshSession(): Promise<Session | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const next = await authPost<Session>("refresh");
      setSession(next);
      return next;
    } catch {
      setSession(null);
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  hasRetried = false,
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.status === 401 && !hasRetried) {
    const restored = await refreshSession();
    if (restored) return api<T>(path, options, true);
    onSessionExpired?.();
    throw new ApiError("UNAUTHENTICATED", "Your session has expired.", 401);
  }

  return parseResponse<T>(response);
}
