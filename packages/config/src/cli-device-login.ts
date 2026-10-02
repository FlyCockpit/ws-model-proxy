import { validateForwarderSlug } from "./forwarder-identifiers";

/**
 * `wsmp login` binds the CLI slug to the device authorization request itself,
 * so the browser approval covers exactly one slug: the CLI sends
 * `scope = "cli-slug:<slug>"` to `/api/auth/device/code`, Better Auth stores it
 * on the `DeviceCode` row, the approval page shows it, and the exchange mints
 * for that slug only. The Rust CLI builds the same string in
 * `apps/cli/src/auth.rs` (`device_login_scope`).
 */
export const CLI_DEVICE_LOGIN_SCOPE_PREFIX = "cli-slug:";

export function cliDeviceLoginScope(slug: string): string {
  return `${CLI_DEVICE_LOGIN_SCOPE_PREFIX}${slug}`;
}

/**
 * The CLI slug a device authorization request was made for, or null when the
 * scope is missing, has anything besides one `cli-slug:<slug>` token, or names
 * an invalid slug.
 */
export function cliSlugFromDeviceLoginScope(scope: string | null | undefined): string | null {
  if (typeof scope !== "string" || !scope.startsWith(CLI_DEVICE_LOGIN_SCOPE_PREFIX)) return null;
  const slug = scope.slice(CLI_DEVICE_LOGIN_SCOPE_PREFIX.length);
  return validateForwarderSlug(slug).ok ? slug : null;
}

/** First wsmp release that speaks relay protocol 2.4 and binds the login slug. */
export const WSMP_MIN_CLI_VERSION = "0.4.0";

/**
 * Lifetime of a `wsmp login` device code, in minutes. The one number both
 * forms below derive from: the `deviceAuthorization` plugin's `expiresIn`
 * (packages/auth/src/index.ts) and the exchange's `retryAfterMs` clamp, so a
 * refusal never tells a client to wait past the code's expiry.
 */
const CLI_DEVICE_CODE_LIFETIME_MINUTES = 30;
/** The lifetime as the plugin's `ms`-style duration string. */
export const CLI_DEVICE_CODE_EXPIRES_IN = `${CLI_DEVICE_CODE_LIFETIME_MINUTES}m` as const;
/** The lifetime in milliseconds. */
export const CLI_DEVICE_CODE_LIFETIME_MS = CLI_DEVICE_CODE_LIFETIME_MINUTES * 60_000;

/**
 * Device code handed to a `wsmp login` too old to send the `cli-slug:` scope.
 * Released 0.3.x CLIs print only "http status: 400" for a refused
 * `/device/code`, but they do print the message of a failed exchange, so the
 * server answers with this code and the exchange refuses it with
 * `CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE`. It never names a real request.
 */
export const CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE = "wsmp-upgrade-required";

/**
 * Shown by an old `wsmp login`. Must not contain "pending", "denied",
 * "expired", or "polling too fast": 0.3.x matches those words in the error.
 */
export const CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE = `This server requires wsmp ${WSMP_MIN_CLI_VERSION} or newer. Upgrade wsmp, then run \`wsmp login\` again.`;

/**
 * Why the approval page's two procedures (`cliCredentials.deviceLoginRequest`
 * and `approveDeviceLogin`) refuse a request, sent as ORPCError
 * `data.reason` so the page can say what happened and what to do next (the
 * message text is never shown). The reasons say nothing an account could not
 * already learn by holding the user code: another account's request is
 * `not_found`, exactly as if the code did not exist.
 *
 * - `not_found`: no request with this code is visible to this account (wrong
 *   code, wrong account, or already redeemed by the CLI).
 * - `expired`: the request outlived its lifetime.
 * - `already_handled`: it was denied, or another account approved it first.
 * - `already_used`: it vanished while approving — approved and redeemed by
 *   the CLI in between, or swept after expiry. Nothing further to approve.
 * - `slug_mismatch`: the request is for a different CLI slug than the page
 *   showed (the page is stale).
 * - `no_slug`: the request names no CLI slug (a CLI older than
 *   {@link WSMP_MIN_CLI_VERSION}).
 */
export const DEVICE_LOGIN_REFUSAL_REASONS = [
  "not_found",
  "expired",
  "already_handled",
  "already_used",
  "slug_mismatch",
  "no_slug",
] as const;

export type DeviceLoginRefusalReason = (typeof DEVICE_LOGIN_REFUSAL_REASONS)[number];

const deviceLoginRefusalReasons: ReadonlySet<string> = new Set(DEVICE_LOGIN_REFUSAL_REASONS);

export function isDeviceLoginRefusalReason(value: unknown): value is DeviceLoginRefusalReason {
  return typeof value === "string" && deviceLoginRefusalReasons.has(value);
}

/** The `data.reason` of an error thrown by the approval procedures, or null. */
export function deviceLoginRefusalReasonOf(error: unknown): DeviceLoginRefusalReason | null {
  if (typeof error !== "object" || error === null) return null;
  const data: unknown = Reflect.get(error, "data");
  if (typeof data !== "object" || data === null) return null;
  const reason: unknown = Reflect.get(data, "reason");
  return isDeviceLoginRefusalReason(reason) ? reason : null;
}
