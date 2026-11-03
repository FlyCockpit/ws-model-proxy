/**
 * A person's saved order for a list (Terminals page tabs and nodes). The saved order is a list
 * of ids, first first; it can name items that are gone (an ended terminal, a node on another
 * account) and miss items that are new.
 */

/** How many ids a saved order keeps (the server's limit). */
export const SAVED_ORDER_MAX = 200;

/** The id shape the server accepts in a saved order. */
const SAVED_ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The items in the saved order: listed items first, in the saved order, then the rest in the
 * order they came. An item without an id (a terminal still opening) is never listed. Stable,
 * and it never adds or drops an item.
 */
export function applySavedOrder<T>(
  items: readonly T[],
  idOf: (item: T) => string | null,
  saved: readonly string[],
): T[] {
  if (saved.length === 0) return [...items];
  const position = new Map<string, number>();
  for (const [index, id] of saved.entries()) if (!position.has(id)) position.set(id, index);
  const rank = (item: T) => {
    const id = idOf(item);
    return id === null ? undefined : position.get(id);
  };
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((left, right) => {
      if (left.rank !== undefined && right.rank !== undefined) return left.rank - right.rank;
      if (left.rank !== undefined) return -1;
      if (right.rank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

/** The list with the item at `from` moved to `to` (both clamped to the list). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [moved] = next.splice(from, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/**
 * The order to save after a move: the ids now shown, in their new order, then the saved ids
 * not shown (a terminal on a node that is offline keeps its place for when it comes back), at
 * most `SAVED_ORDER_MAX`. Ids the server would refuse are left out, as are repeats.
 */
export function nextSavedOrder(
  shownIds: readonly (string | null)[],
  saved: readonly string[],
): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const id of [...shownIds, ...saved]) {
    if (id === null || seen.has(id) || !SAVED_ORDER_ID.test(id)) continue;
    seen.add(id);
    next.push(id);
    if (next.length === SAVED_ORDER_MAX) break;
  }
  return next;
}
