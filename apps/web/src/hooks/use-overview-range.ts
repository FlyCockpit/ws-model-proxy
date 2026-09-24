import { OVERVIEW_RANGES, type OverviewRange } from "@ws-model-proxy/config/usage-metrics";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Per-viewer Overview range preference. A convenience only: every storage
 * access is wrapped because private windows, blocked site data and previews
 * can throw, and the page must work (default 24h) without it.
 *
 * `useSyncExternalStore` with a fixed server snapshot keeps SSR hydration
 * stable (the server always renders the default) and reflects changes made in
 * other tabs through the `storage` event — no effect needed.
 */
export const OVERVIEW_RANGE_STORAGE_KEY = "wsmp.overview.range";
export const DEFAULT_OVERVIEW_RANGE: OverviewRange = "24h";

const listeners = new Set<() => void>();

function isOverviewRange(value: unknown): value is OverviewRange {
  return typeof value === "string" && (OVERVIEW_RANGES as readonly string[]).includes(value);
}

function readStoredRange(): OverviewRange {
  try {
    const stored = window.localStorage.getItem(OVERVIEW_RANGE_STORAGE_KEY);
    return isOverviewRange(stored) ? stored : DEFAULT_OVERVIEW_RANGE;
  } catch {
    return DEFAULT_OVERVIEW_RANGE;
  }
}

let memoryRange: OverviewRange | null = null;

function snapshot(): OverviewRange {
  return memoryRange ?? readStoredRange();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OVERVIEW_RANGE_STORAGE_KEY) return;
    memoryRange = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function serverSnapshot(): OverviewRange {
  return DEFAULT_OVERVIEW_RANGE;
}

export function useOverviewRange(): [OverviewRange, (range: OverviewRange) => void] {
  const range = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const setRange = useCallback((next: OverviewRange) => {
    if (!isOverviewRange(next)) return;
    // The in-memory value keeps the choice for this session even when
    // storage is unavailable.
    memoryRange = next;
    try {
      window.localStorage.setItem(OVERVIEW_RANGE_STORAGE_KEY, next);
    } catch {
      // Storage blocked: the in-memory value still applies to this tab.
    }
    for (const listener of listeners) listener();
  }, []);
  return [range, setRange];
}

/** Test seam: forget the in-memory choice. */
export function resetOverviewRangeForTests() {
  memoryRange = null;
}
