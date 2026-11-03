import { useState } from "react";

export type RowKeys = { kept: string[]; next: number };

/** The key of row `index`: a kept one, or else a fresh one numbered on from `next`. */
export function rowKeyAt(state: RowKeys, prefix: string, index: number): string {
  return state.kept[index] ?? `${prefix}${state.next + index - state.kept.length}`;
}

/** The keys after removing row `index` of `length`: every other row keeps its key. */
export function removeRowKey(
  state: RowKeys,
  prefix: string,
  length: number,
  index: number,
): RowKeys {
  const keys = Array.from({ length }, (_, at) => rowKeyAt(state, prefix, at));
  return {
    kept: keys.filter((_, at) => at !== index),
    next: state.next + Math.max(0, length - state.kept.length),
  };
}

/**
 * React keys for the rows of a form array whose rows have no id of their own. The keys live
 * beside the form (never in its values, so nothing extra is submitted): rows added at the end
 * get fresh keys, and `remove` drops the removed row's key, so every other row keeps its
 * element (focus and typed input stay in their row). A list replaced as a whole keeps its
 * keys by position, as index keys would.
 */
export function useRowKeys(prefix: string) {
  const [state, setState] = useState<RowKeys>({ kept: [], next: 0 });
  return {
    key: (index: number) => rowKeyAt(state, prefix, index),
    /** Call with the row count before `removeValue(index)`. */
    remove: (length: number, index: number) =>
      setState((current) => removeRowKey(current, prefix, length, index)),
  };
}
