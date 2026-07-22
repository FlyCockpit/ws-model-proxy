/**
 * Search-param contract for `/$lang/verify-email`.
 *
 * Lives here rather than inline in the route so it can be unit tested against
 * the router's real search parser. Route files must not export anything.
 *
 * The landing page has three states, driven entirely by these two params:
 *
 *   ?ok=1              → verified (Better-Auth redirected here on success)
 *   ?error=<CODE>      → the token was bad, expired, or already used
 *   neither            → "we don't know" — render the resend form
 *
 * `error` wins over `ok`: a failed hop arrives as `?ok=1&error=<CODE>`.
 */
export type VerifyEmailSearch = {
  error: string | undefined;
  ok: true | undefined;
};

export function parseVerifyEmailSearch(search: Record<string, unknown>): VerifyEmailSearch {
  return {
    error: typeof search.error === "string" ? search.error : undefined,
    // Accept every spelling of the success marker. The router parses search
    // values with `JSON.parse`, so the `?ok=1` that `buildCallback`
    // (packages/auth/src/verification-callback.ts) emits arrives as the NUMBER
    // 1 — not the string "1".
    ok: search.ok === 1 || search.ok === "1" || search.ok === true ? true : undefined,
  };
}
