import { useSyncExternalStore } from "react";

const subscribeNever = () => () => {};

/**
 * A date as the browser shows it (its timezone, and `locale` or the browser's default), safe to
 * use while rendering on the server: the server has no timezone of the viewer, so it renders the
 * UTC calendar date (`YYYY-MM-DD`) and the browser swaps in its own text after hydration, keeping
 * the server and first client render identical.
 */
export function useClientDateText(
  value: Date | string,
  options?: { locale?: string; format?: Intl.DateTimeFormatOptions },
): { text: string; iso: string } {
  const date = new Date(value);
  const iso = date.toISOString();
  const text = useSyncExternalStore(
    subscribeNever,
    () => date.toLocaleDateString(options?.locale, options?.format),
    () => iso.slice(0, 10),
  );
  return { text, iso };
}
