// §10.3–10.4 offline mutation queue.
//
// Mutations that are safe to perform offline are queued in localStorage with
// a stable operationId and the entity version the device last saw. On
// reconnect they are pushed to /sync/mutations, which is idempotent, so a
// replay after a half-failed flush cannot double-apply anything.

import { api, getSession } from "./api";

const QUEUE_KEY = "lodgiva.offline.queue";
const CURSOR_KEY = "lodgiva.offline.cursor";
const LAST_SYNC_KEY = "lodgiva.offline.lastSync";
const DEVICE_KEY = "lodgiva.deviceId";

export interface QueuedMutation {
  operationId: string;
  entityType: "housekeepingTask" | "maintenanceTicket" | "room";
  entityId: string;
  baseVersion?: number;
  action: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  label: string; // what to show the user while it is pending
}

export interface SyncResult {
  applied: unknown[];
  conflicts: { message: string; resolution?: string }[];
  rejected: { message: string }[];
  serverChanges: unknown[];
  nextCursor: string;
}

export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function readQueue(): QueuedMutation[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]") as QueuedMutation[];
  } catch {
    return [];
  }
}

function writeQueue(q: QueuedMutation[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  window.dispatchEvent(new CustomEvent("lodgiva:queue"));
}

export function enqueue(m: Omit<QueuedMutation, "operationId" | "occurredAt">) {
  const item: QueuedMutation = {
    ...m,
    operationId: `op_${deviceId()}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    occurredAt: new Date().toISOString(),
  };
  writeQueue([...readQueue(), item]);
  return item;
}

export function lastSyncAt(): string | null {
  return localStorage.getItem(LAST_SYNC_KEY);
}

/**
 * True when the failure was "we could not reach the server" rather than the
 * server rejecting the request. `navigator.onLine` alone is not enough — a
 * captive portal or a down backend leaves the browser "online" while every
 * request fails, which is exactly when queueing matters most.
 */
export function isConnectivityFailure(err: unknown): boolean {
  if (!navigator.onLine) return true;
  if (err instanceof TypeError) return true; // fetch could not reach the host
  const status = (err as { status?: number })?.status ?? 0;
  // Any 5xx means the request was not deterministically processed — an
  // unreachable upstream behind a proxy surfaces as 500/502/503/504. Queueing
  // is safe because /sync/mutations is idempotent on operationId, so a change
  // that did land is never applied twice.
  return status >= 500;
}

let flushing = false;

/**
 * Push the queue and pull server changes. Returns null when there is nothing
 * to do or the device is offline/signed out.
 */
export async function flush(): Promise<SyncResult | null> {
  if (flushing || !navigator.onLine || !getSession()) return null;
  const queue = readQueue();
  flushing = true;
  try {
    const res = await api<SyncResult>("/sync/mutations", {
      method: "POST",
      body: {
        deviceId: deviceId(),
        lastServerCursor: localStorage.getItem(CURSOR_KEY) ?? undefined,
        mutations: queue.map(({ label: _label, ...m }) => m),
      },
    });
    // Everything the server acknowledged — applied, conflicting or rejected —
    // leaves the queue. Conflicts are surfaced, not retried blindly.
    writeQueue([]);
    localStorage.setItem(CURSOR_KEY, res.nextCursor);
    localStorage.setItem(LAST_SYNC_KEY, new Date().toISOString());
    return res;
  } catch {
    // Still offline or the server is unreachable — keep the queue for later.
    return null;
  } finally {
    flushing = false;
  }
}

/** Flush on reconnect and periodically while online. */
export function startAutoSync(onResult?: (r: SyncResult) => void) {
  const run = async () => {
    const r = await flush();
    if (r && onResult) onResult(r);
  };
  window.addEventListener("online", run);
  const timer = window.setInterval(run, 20_000);
  void run();
  return () => {
    window.removeEventListener("online", run);
    window.clearInterval(timer);
  };
}
