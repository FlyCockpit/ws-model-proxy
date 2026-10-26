/**
 * Batched sweeps of the lifecycle engine reach every matching row, however many rows a pass
 * cannot act on. A sweep reads a bounded page (`take`), and some rows it reads may not progress
 * on that pass (a prepared start waiting for its person, a step whose turn has not come, a write
 * that keeps failing): if every pass read the same first page, rows behind it would never be
 * reached.
 *
 * Two shapes are allowed, and `run-ownership.census.test.ts` checks every `take:` of the
 * engine's production files against them:
 * - a {@link SweepCursor} page: rows in id order after the cursor; a full page moves the cursor
 *   to its last row, a short one starts the next pass from the beginning (so every row is read
 *   within ceil(rows / size) + 1 passes). The pass then works its page in its own priority order.
 * - a durable stamp rotation (`reconcileStopping`'s `lastStopReconcileAt`, `probeHeldUnknown`'s
 *   `lastStopCheckAt`): each row read is stamped before its work, which sends it to the back of
 *   the next pass's order. The site is marked `// sweep: stamp rotation`.
 *
 * The cursor is this process's: another server process rotates its own.
 */
export type SweepPage = {
  where: { id?: { gt: string } };
  orderBy: { id: "asc" };
  take: number;
};

export class SweepCursor {
  #after: string | null = null;

  constructor(readonly size: number) {}

  /** Reads the next page with `read` and moves the cursor past it. */
  async next<Row extends { id: string }>(
    read: (page: SweepPage) => Promise<Row[]>,
  ): Promise<Row[]> {
    const rows = await read({
      where: this.#after === null ? {} : { id: { gt: this.#after } },
      orderBy: { id: "asc" },
      take: this.size,
    });
    this.#after = rows.length >= this.size ? (rows.at(-1)?.id ?? null) : null;
    return rows;
  }
}

/** `rows` sorted by `key` ascending (a page worked in its pass's priority order), stable. */
export function byKey<Row>(rows: readonly Row[], key: (row: Row) => number): Row[] {
  return [...rows].sort((a, b) => key(a) - key(b));
}
