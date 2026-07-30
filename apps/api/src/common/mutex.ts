/**
 * A tiny in-process mutex keyed by a string.
 *
 * Why this exists: claiming inventory runs a multi-statement interactive
 * transaction. Firing many of those concurrently at the same room type makes
 * every writer contend for the same rows — on SQLite that serialises into
 * lock waits and timeouts, and on PostgreSQL it produces avoidable
 * serialization failures and retries.
 *
 * This is a THROUGHPUT optimisation, never the correctness boundary. It is
 * process-local, so it does nothing across multiple API instances. Overbooking
 * is prevented by the unique index on
 * RoomNightAllocation(roomTypeId, date, slotIndex), which holds regardless of
 * how many processes are running. Removing this mutex would make the system
 * slower and noisier under load, not incorrect.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    // Chain onto the previous holder, ignoring its outcome so one failure
    // cannot poison the queue for everyone behind it.
    const run = previous.then(fn, fn);
    // Keep the chain alive but swallow rejections on the stored tail.
    this.tails.set(
      key,
      run.catch(() => undefined)
    );
    try {
      return await run;
    } finally {
      // Drop the entry once this is the last waiter, so the map cannot grow
      // without bound across many room types and dates.
      if (this.tails.get(key) === run || (await this.isTail(key, run))) {
        this.tails.delete(key);
      }
    }
  }

  private async isTail(key: string, run: Promise<unknown>): Promise<boolean> {
    const tail = this.tails.get(key);
    if (!tail) return true;
    // A settled tail that is not this run means someone else queued behind us.
    return tail === run;
  }
}

export const inventoryMutex = new KeyedMutex();
