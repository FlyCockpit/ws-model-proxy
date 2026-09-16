/**
 * Better Auth logger bridge — TERMINAL log-sanitizer policy v3.3
 * (invariant 10 / L19; pass 10: CHARACTER-ONLY MAXIMAL trigger set,
 * user-ruled; pass 11: `?`/`#` added + minimal AUTH-SCHEME WORD trigger
 * Bearer/Basic/DPoP, from R37/R38; pass 12: `/` added — any single slash
 * — from R40, closing path-carried credentials).
 *
 * Probe-verified installed call sites (better-auth@1.7.3) hand the
 * configured `logger.log` THREE hazardous first-argument shapes:
 *   1. raw Error objects (e.g. the list-sessions route catch logs the raw
 *      storage rejection; stringifying it embeds Prisma SQL + params),
 *   2. plain STRING args that already contain `error.message` /
 *      `error.stack` (introspect-CbhhXT0E.mjs:2542/2545,
 *      authorize-9whjxVLJ.mjs:3612/3615),
 *   3. strings embedding signed OAuth query pairs (`Invalid origin:
 *      <referer>?state=…&sig=…`, `Invalid callbackURL: <url>`).
 *
 * TERMINAL POLICY v3.1 — structure-triggered WHOLE-MESSAGE redaction with
 * the CHARACTER-ONLY MAXIMAL trigger set.
 *
 * History: passes 6–8 attempted PARTIAL scrubbing of string-first
 * messages (sensitive key=value pairs, then URL parsing with
 * userinfo/query/fragment markers, orphan-value consumption, and marker
 * post-passes). Four review rounds (R29–R33) each found new bypass
 * shapes — percent-encoded keys, terminator-delimited values,
 * case-variant schemes, protocol-relative `//host?…`, backslash schemes
 * `https:\\host`, control-character key splits (`sta<TAB>te=`),
 * whitespace/multi-token values (`?state=public SECRET`), fragment-only
 * `# SECRET`, and multi-URL re-scan artifacts. Partial scrubbing of
 * arbitrary attacker-influenced strings is PROVABLY unfinishable: every
 * redaction boundary is itself an attacker-testable parsing decision.
 *
 * v3 removes the boundary problem entirely: a string-first message that
 * contains ANY structural character that could carry URL/query/credential
 * syntax is redacted WHOLE — the emitted line is exactly
 * `[auth] <effectiveLevel> [message-redacted: untrusted structure]`.
 * The original message NEVER appears, not even a prefix.
 *
 * Pass-10 revision (user ruling, from R35/R36): the pass-9 trigger set
 * (`://`, `//`, `\`, `=`, control) still let through URL forms that use
 * NONE of those separators yet still carry credentials — `https:user:SECRET@evil.example/cb`
 * and `https:/user:SECRET@…` (single/no-slash schemes parse in WHATWG URL
 * with the sentinel as the password), `Authorization: Bearer SECRET`
 * (header syntax), `{"access_token":"x"}` (JSON), and percent-encoded
 * spellings. The remedy is the CHARACTER-ONLY MAXIMAL set — deliberately
 * NO word list: static provider diagnostics such as "authorization code
 * replay cleanup failed" or "Invalid password" contain no trigger
 * characters and keep passing verbatim (a whitelist effect achieved by
 * grammar, not by maintaining a list that reviewers can bypass with
 * synonyms).
 *
 * Trigger set (hasUntrustedStructure — ANY ONE triggers redaction):
 *   - `:` (any colon — schemes `https:`, header syntax `Authorization:`,
 *     single/no-slash URL forms `https:user:pw@host`),
 *   - `=` (any equals — key=value pairs),
 *   - `@` (any at-sign — userinfo credentials, email addresses),
 *   - `?` (any question mark — relative-reference query carriers
 *     `/callback?SECRET`; pass-11: closes the R37/R38 query carriers),
 *   - `#` (any hash — relative-reference fragment carriers `/cb#SECRET`;
 *     pass-11: closes the R37/R38 fragment carriers),
 *   - `{` or `}` (braces — JSON/object literals),
 *   - `"` (double quote), `'` (single quote), `` ` `` (backtick) —
 *     string-literal/quoted-value carriers,
 *   - `%` (any percent — percent-encoding of ANY trigger character),
 *   - `\` (any backslash — backslash-delimited spellings),
 *   - `/` (any single slash — pass 12, from R40: path-carried
 *     credentials. `/api/auth/reset-password/R40SECRET` carries a LIVE
 *     token in a URL PATH segment and contains no other trigger; every
 *     URL, absolute path, and relative reference requires a slash or a
 *     colon, so the single-slash trigger closes the whole carrier class.
 *     The former explicit `//` alternative is subsumed),
 *   - a control character `/[\x00-\x1f\x7f]/` (tab, CR, LF, VT, FF,
 *     NUL, DEL — control-char key splits and encoded-boundary tricks),
 *   - PLUS a minimal AUTH-SCHEME WORD trigger (pass-11, user-ruled from
 *     R37/R38): the words Bearer/Basic/DPoP (case-insensitive) at the
 *     start of the message or after whitespace, followed by whitespace
 *     or a `=`/`-` delimiter — `Bearer SECRET`, `Basic aWQ6U0VDUkVU`,
 *     `DPoP SECRET`. These three words are authentication-credential
 *     markers (the installed provider's parsers recognize exactly these
 *     schemes and decode what follows into credentials), not diagnostic
 *     vocabulary — this is NOT a general word list.
 *
 * Completeness argument: the output grammar of an UNTRIGGERED message
 * (prose tokens separated by single spaces, no colon/equals/at/question/
 * hash/slash/braces/quotes/backtick/percent/backslash/control, and no
 * auth-scheme word) provably cannot express URLs (need `:` or `/` or
 * `\` or `?` or `#`), PATH-CARRIED credentials (any URL, absolute path,
 * or relative reference requires a slash or colon — pass 12),
 * key=value pairs (need `=`), JSON (needs `{`/`"`), headers (need `:`),
 * percent-encoded forms (need `%`), or scheme-marked credentials (need
 * the scheme word). Sole residual: bare tokens with NO structural
 * carrier AND no scheme word (accepted below).
 *
 * Diagnostic trade-off (user-ruled): the maximal set redacts MORE
 * legitimate diagnostics than pass 9 — e.g. "Failed to query fallback
 * join for model user:" (contains `:`) and the "Invalid origin:" /
 * "Invalid callbackURL:" prefixes now emit the marker instead of the
 * message. Accepted in exchange for closing every structural carrier;
 * trigger-free static diagnostics still pass verbatim.
 *
 * Accepted residual: a bare secret value embedded with NO structural
 * carrier and NO scheme word (e.g. `oops SECRETVALUE leaked` with no
 * trigger character and no Bearer/Basic/DPoP marker around it). This is outside invariant 10's letter
 * (the secret must be carried by URL/query/credential structure to be
 * recognizable as such), is unpreventable in principle for ANY
 * content-based filter, and is only constructible by a party that
 * already holds the secret.
 *
 * Unchanged from earlier passes:
 * - Non-string first arg (A1): emit exactly `[auth] <effectiveLevel>
 *   (<label>)` where label is the first arg's constructor name for
 *   Errors, else its typeof. NO message, NO stringification, NO other
 *   property access.
 * - Rest args: at error/warn only, `(Error: <ctor name>)` markers for
 *   Error-instance entries (constructor names carry no message content);
 *   ALL other rest entries are dropped. Info drops every rest entry.
 * - USER_INPUT_ERROR_PATTERN downgrade (error→warn) applies to string
 *   firsts only.
 * - Levels: error/warn → the single sanitized line; info → message only;
 *   debug → dropped. `success` is mapped to info behavior defensively.
 * - 200-char truncation as a final safety on any verbatim emission
 *   (redacted marker lines are fixed-length and never truncated).
 * - Structural completeness: string-first vs non-string-first is
 *   exhaustive, and NOTHING beyond the first arg is ever emitted except
 *   the `(Error: <ctor>)` markers at error/warn level.
 */

// Better-Auth emits "user input failed validation" cases (wrong password,
// unknown email, unverified email, etc.) at level=error. Those are normal
// end-user mistakes, not server faults — downgrade them to warn so
// production error dashboards stay signal-y. Anything we don't recognize
// keeps its original level. (String firsts only — see the header.)
const USER_INPUT_ERROR_PATTERN =
  /invalid (password|email|credentials|token|otp|two[- ]?factor)|user not found|email not verified|password is incorrect|account not found|failed to verify|already exists|too many (requests|attempts)/i;

// v3.3 trigger set (pass 12, from R40): the pass-11 CHARACTER-ONLY
// MAXIMAL set (`:` `=` `@` `{` `}` `"` `'` `` ` `` `%` `\` `?` `#`
// control) EXTENDED with `/` (any single slash — path-carried
// credentials such as `/api/auth/reset-password/<token>`; subsumes the
// former explicit `//` alternative) PLUS the minimal AUTH-SCHEME WORD
// trigger — Bearer/Basic/DPoP (case-insensitive) at message start or
// after whitespace, followed by whitespace or a `=`/`-` delimiter. The
// three scheme words are authentication-credential markers recognized by
// the installed provider's parsers — deliberately NOT a general word
// list. No `g` flag — pure boolean tests.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0/C1 control-character class IS the security trigger (control-char key splits, encoded-boundary tricks) — intentional by design.
const UNTRUSTED_STRUCTURE_PATTERN = /[/?#:=@{}"'`%\\]|[\x00-\x1f\x7f]/;
const AUTH_SCHEME_WORD_PATTERN = /(^|[\s])(bearer|basic|dpop)([\s]+|[=-])/i;

/**
 * TERMINAL POLICY v3.3 trigger: does this string-first message contain ANY
 * character that could carry URL / path / query / credential / header /
 * JSON structure (including any single slash — path-carried credentials),
 * OR a Bearer/Basic/DPoP scheme word marking what follows as
 * credentials? If so the caller must emit the whole-message redaction
 * marker instead of the message. Pure literal tests — no parsing, no
 * boundaries to bypass.
 */
export function hasUntrustedStructure(message: string): boolean {
  return UNTRUSTED_STRUCTURE_PATTERN.test(message) || AUTH_SCHEME_WORD_PATTERN.test(message);
}

/** Whole-message redaction marker (fixed text, no interpolation). */
export const MESSAGE_REDACTED_MARKER = "[message-redacted: untrusted structure]";

/** Longest `[auth] ` message body ever emitted (final safety cap). */
const MAX_MESSAGE_LENGTH = 200;

/** Levels better-auth can dispatch to the custom logger.log. */
export type AuthBridgeLevel = "debug" | "info" | "warn" | "error";

/** One sanitized console line (always exactly one string argument). */
export type AuthBridgeEmission = { method: "error" | "warn" | "info"; args: [line: string] };

/**
 * Decide what (if anything) the bridge lets through to the console for one
 * better-auth logger call. Returns null when nothing may be logged.
 */
export function resolveAuthLogCall(
  level: AuthBridgeLevel | "success",
  first: unknown,
  args: readonly unknown[],
): AuthBridgeEmission | null {
  if (level === "debug") return null;
  let effective: AuthBridgeLevel | "success" = level;
  if (effective === "error" && typeof first === "string" && USER_INPUT_ERROR_PATTERN.test(first)) {
    effective = "warn";
  }
  const levelLabel = effective === "success" ? "info" : effective;
  const method: AuthBridgeEmission["method"] =
    effective === "info" || effective === "success" ? "info" : effective;

  if (typeof first === "string") {
    // TERMINAL POLICY v3.1: structure-triggered whole-message redaction.
    // A message carrying ANY URL/query/credential structural character
    // is never emitted — not partially, not prefixed, never. The marker
    // line carries the effective level; clean messages pass VERBATIM
    // (no level label — unchanged `[auth] <message>` shape).
    // Redacted line carries the effective level; the VERBATIM line keeps
    // the historical `[auth] <message>` shape with no level label.
    let line = hasUntrustedStructure(first)
      ? `[auth] ${levelLabel} ${MESSAGE_REDACTED_MARKER}`
      : `[auth] ${first.slice(0, MAX_MESSAGE_LENGTH)}`;
    if (method !== "info") {
      for (const arg of args) {
        if (arg instanceof Error) line += ` (Error: ${arg.constructor?.name ?? "Error"})`;
      }
    }
    return { method, args: [line] };
  }

  // Non-string first arg: constructor name for Errors, typeof otherwise.
  // No message, no stringification, no other property access.
  const label = first instanceof Error ? (first.constructor?.name ?? "Error") : typeof first;
  return { method, args: [`[auth] ${levelLabel} (${label})`] };
}
