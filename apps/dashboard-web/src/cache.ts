/**
 * §10.2 offline read cache.
 *
 * localStorage was enough for the write queue (small, synchronous, rarely
 * read), but it is the wrong tool for cached responses: a 5MB shared quota,
 * synchronous access that blocks the main thread, and string-only values.
 * IndexedDB gives room for a property's worth of data and keeps parsing off
 * the render path.
 *
 * What may be cached is deliberately narrow (§10.2): operational reads that
 * a housekeeper or supervisor needs to keep working. Money, folios, payments
 * and reports are never cached — a stale balance is worse than no balance.
 */

const DB_NAME = "lodgiva";
const DB_VERSION = 1;
const STORE = "reads";

/** Only these paths may be cached; anything else is fetched or fails. */
const CACHEABLE = [
  /^\/properties\/[^/]+\/room-rack/,
  /^\/housekeeping\/tasks/,
  /^\/maintenance\/tickets/,
  /^\/config\/rooms/,
  /^\/config\/room-types/,
  /^\/auth\/me$/,
  /^\/front-desk\/(arrivals|departures|in-house)/,
];

/** Never cached, even if something asks: staleness here is dangerous. */
const NEVER_CACHE = [
  /^\/folios/,
  /^\/payments/,
  /^\/invoices/,
  /^\/reports/,
  /^\/cashiering/,
  /^\/gateway/,
  /^\/settlements/,
];

export function isCacheable(path: string): boolean {
  const clean = path.split("?")[0];
  if (NEVER_CACHE.some((re) => re.test(clean))) return false;
  return CACHEABLE.some((re) => re.test(clean));
}

export interface CachedEntry<T = unknown> {
  key: string;
  data: T;
  cachedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest
): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    // A browser with IndexedDB disabled degrades to "no cache", never to a
    // crash — the app still works online.
    return null;
  }
}

export async function readCache<T>(key: string): Promise<CachedEntry<T> | null> {
  return withStore<CachedEntry<T>>("readonly", (s) => s.get(key));
}

export async function writeCache(key: string, data: unknown): Promise<void> {
  await withStore("readwrite", (s) =>
    s.put({ key, data, cachedAt: Date.now() } satisfies CachedEntry)
  );
}

export async function clearCache(): Promise<void> {
  await withStore("readwrite", (s) => s.clear());
}

/** How stale the cached copy is, for honest labelling in the UI. */
export function ageLabel(cachedAt: number): string {
  const mins = Math.floor((Date.now() - cachedAt) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
