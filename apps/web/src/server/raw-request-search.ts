import { createServerFn } from "@tanstack/react-start";

/**
 * RAW (never re-serialized) request query string for the MCP page routes
 * (MCP plan Phase 6, Part H pass 2 — R83/R84 F1).
 *
 * TanStack Router round-trips search through parseSearch → stringifySearch on
 * every navigation and even when deriving `location.searchStr`, which
 * collapses Better Auth's REPEATED `ba_param` keys and kills the signature.
 * The raw query is therefore taken from the two sources that never
 * round-trip: the browser's `window.location.search` (client) or the raw
 * request URL (server — this server function). Initialization failures
 * resolve to an empty string: the transition still happens, and the target
 * page renders its localized invalid-request card rather than a signed-query
 * page built on a guessed query (fail-safe, never a leak).
 */
export const getRawRequestSearch = createServerFn({ method: "GET" }).handler(
  async (): Promise<string> => {
    try {
      const { getRequestUrl } = await import("@tanstack/react-start/server");
      return new URL(getRequestUrl()).search;
    } catch {
      return "";
    }
  },
);
