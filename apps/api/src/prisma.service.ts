import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "async_hooks";

type TransactionClient = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** Errors that mean "try again", not "this request is wrong". */
const TRANSIENT = new Set([
  "P2024", // pool timeout
  "P2034", // transaction conflict / deadlock (write conflict on Postgres)
  "P1008", // operation timed out
]);

function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (code && TRANSIENT.has(code)) return true;
  const message = (err as { message?: string })?.message ?? "";
  // SQLite surfaces contention as a socket timeout or a busy database rather
  // than a typed code.
  return /socket timeout|database is locked|SQLITE_BUSY/i.test(message);
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private static readonly tenantTransaction = new AsyncLocalStorage<TransactionClient>();
  /** The Proxy this constructor returns; see the note in the constructor. */
  private self!: PrismaService;

  constructor() {
    super({
      // Interactive transactions that claim inventory do several reads and
      // writes; the defaults (2s wait / 5s run) are too tight once requests
      // queue behind SQLite's single writer.
      transactionOptions: {
        maxWait: Number(process.env.DB_TX_MAX_WAIT_MS ?? 15_000),
        timeout: Number(process.env.DB_TX_TIMEOUT_MS ?? 20_000),
      },
    });
    // Existing services use Prisma's generated model properties directly.
    // Route those properties (and nested interactive transactions) to the
    // request's tenant-scoped transaction without a risky whole-codebase
    // repository rewrite.
    // The constructor returns a Proxy, so `this` inside a method is the raw
    // target — and Prisma's own client internals are only reachable through
    // the proxy. Keep a handle on it for the one method that needs to
    // re-enter the client from outside the request's transaction.
    const proxy: PrismaService = new Proxy(this, {
      get: (target, property, receiver) => {
        const tx = PrismaService.tenantTransaction.getStore() as Record<PropertyKey, unknown> | undefined;
        if (tx && property === "$transaction") {
          return async (operation: unknown) => {
            if (typeof operation !== "function") {
              throw new Error("Batch transactions are not supported inside a tenant request.");
            }
            return (operation as (client: TransactionClient) => unknown)(tx as TransactionClient);
          };
        }
        if (tx && property in tx) {
          const value = tx[property];
          return typeof value === "function" ? value.bind(tx) : value;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    this.self = proxy;
    return proxy;
  }

  /**
   * Runs work in a NEW transaction that commits independently of the request.
   *
   * Every request is wrapped in a single tenant transaction (see
   * TenantContextInterceptor), so a thrown error rolls back everything the
   * request did — including work that was meant to outlive the failure. Check
   * out is the case that forced this: it posts the room charges for nights
   * actually stayed and then refuses if the folio is unsettled, and those two
   * things must not share a fate. The nights were stayed; the ledger has to
   * say so whether or not the guest can pay this minute.
   *
   * Exiting the AsyncLocalStorage is what makes it a real second transaction:
   * without it the proxy above routes straight back into the request's own.
   * Use this only for work that is correct on its own — never to paper over a
   * failure that should have rolled the whole request back.
   */
  async runInNewTenantTransaction<T>(
    tenantId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return PrismaService.tenantTransaction.exit(() =>
      this.self.runWithTenant(tenantId, operation)
    );
  }

  async runWithTenant<T>(tenantId: string, operation: () => Promise<T>): Promise<T> {
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return PrismaService.tenantTransaction.run(tx, operation);
    });
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Runs a transaction, retrying transient contention with jittered backoff.
   *
   * Under concurrency SQLite serialises writers and can report a busy/timeout
   * condition; PostgreSQL can raise a serialization failure. Neither means the
   * caller did anything wrong, so the request is retried rather than failed.
   * Genuine conflicts (SOLD_OUT from the unique index) are NOT retried —
   * they are a real answer.
   */
  async transactionWithRetry<T>(
    fn: (tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<T>,
    attempts = Number(process.env.DB_TX_RETRIES ?? 5)
  ): Promise<T> {
    const active = PrismaService.tenantTransaction.getStore();
    if (active) return fn(active);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.$transaction(fn);
      } catch (err) {
        if (!isTransient(err)) throw err;
        lastError = err;
        // Jitter so retried requests do not synchronise into a new pile-up.
        const backoff = 25 * 2 ** attempt + Math.floor(Math.random() * 50);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastError;
  }
}
