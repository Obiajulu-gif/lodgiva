import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

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
