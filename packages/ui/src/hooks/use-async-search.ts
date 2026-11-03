import * as React from "react";

/**
 * Debounce a changing value. Used by the async search loop so we don't fire a
 * request on every keystroke.
 */
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Shared async-search loop for `AsyncCombobox` and `MultiAsyncCombobox`.
 *
 * Debounces the query, fires `onSearch` with an `AbortSignal`, and cancels the
 * in-flight request whenever the query (or `onSearch`) changes. This is the
 * "cancel the previous fetch on every keystroke" semantics that React Query
 * intentionally does not give us.
 */
function useAsyncSearch<T>(
  onSearch: (query: string, signal: AbortSignal) => Promise<T[]>,
  query: string,
) {
  const [results, setResults] = React.useState<T[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const debouncedQuery = useDebounce(query, 300);

  React.useEffect(() => {
    const abortController = new AbortController();
    // Set only by this run's cleanup, so a superseded search never writes its results or clears
    // the loading flag the next search set.
    let cancelled = false;

    async function search() {
      setIsLoading(true);
      try {
        const data = await onSearch(debouncedQuery, abortController.signal);
        if (!cancelled) setResults(data);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- it is in the finally; only a cancelled (superseded) run skips it, since the next run owns the flag
        if (!cancelled) setIsLoading(false);
      }
    }

    void search();
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [debouncedQuery, onSearch]);

  return { results, isLoading };
}

export { useAsyncSearch, useDebounce };
