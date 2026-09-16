/**
 * TEMPORARY console shim enforcing the TERMINAL log-sanitizer bucket policy
 * for raw Error objects (invariant 10 / L19, pass 6, bucket B). REMOVE
 * WHEN a released better-call/better-auth exposes a supported error-logger
 * hook for every path below — re-check at the Better Auth 1.7.4 bump and
 * the Phase 9-10 integration part.
 *
 * Bucket policy (two interception rules, everything else verbatim):
 *
 * B1 — Error-first interception on console.error / console.warn /
 * console.log at ANY arity: installed packages (@better-auth/core
 * factory.mjs handleFallbackJoin paths, better-auth route catches) call
 * `console.error(error)` with the RAW Error as the first argument; a
 * Prisma rejection's message embeds SQL + bind params. Any such call is
 * re-emitted through the ORIGINAL method as ONE line:
 * `<method> (sanitized): <constructor name>` — no message, no stack, no
 * other args. This is the terminal guarantee: even when the adapter-level
 * join fix (advanced.database.joins, bucket C) does not apply —
 * factory.mjs:191-195 still reaches handleFallbackJoin whenever a joined
 * key is absent from the adapter row — the raw Error cannot reach the
 * console.
 *
 * B2 — marker rule (better-call@1.4.0 dist/router.mjs:93,
 * `console.error(`# SERVER_ERROR: `, error)` — a template literal, so the
 * runtime first argument carries a TRAILING SPACE): calls whose first
 * argument is exactly `"# SERVER_ERROR: "` OR `"# SERVER_ERROR:"` are
 * re-emitted as `# SERVER_ERROR (sanitized): <ctor|typeof>` — the
 * second-argument non-Error case degrades to typeof, never
 * String(value).
 *
 * B3 — everything else (including ALL string-first calls) passes through
 * the original method VERBATIM: zero repo call-site impact (surveyed —
 * every repo console.* call is string-first or an f-string template).
 *
 * Residual (ACCEPTED, inventory-covered): string-first direct console
 * calls in installed packages would bypass B1 — none are reachable today
 * (critic survey, pass 6); re-verify at Better Auth bumps.
 *
 * Idempotent: a second install is a no-op. Failure mode if the marker or
 * an Error-first call shape changes upstream: B1 still holds (instanceof
 * is structural); a changed marker degrades to verbatim fallthrough
 * (today's unshimmed behavior) — no crash, no behavior change beyond the
 * log shape.
 */

const SERVER_ERROR_MARKERS = new Set(["# SERVER_ERROR: ", "# SERVER_ERROR:"]);
const SANITIZED_PREFIX = "# SERVER_ERROR (sanitized):";

const SHIMMED_METHODS = ["error", "warn", "log"] as const;

let installed = false;

/**
 * Install the console shim (idempotent). Call once at server startup,
 * before any request handling.
 */
export function installBetterCallErrorLogShim(): void {
  if (installed) return;
  installed = true;
  for (const method of SHIMMED_METHODS) {
    const original = console[method];
    const shimmed = (...data: unknown[]) => {
      const first = data[0];
      if (first instanceof Error) {
        original.call(console, `${method} (sanitized): ${first.constructor?.name ?? "Error"}`);
        return;
      }
      if (method === "error" && typeof first === "string" && SERVER_ERROR_MARKERS.has(first)) {
        const error = data[1];
        const name = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
        original.call(console, `${SANITIZED_PREFIX} ${name}`);
        return;
      }
      original.call(console, ...data);
    };
    console[method] = shimmed;
  }
}
