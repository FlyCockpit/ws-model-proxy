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

/** First wsmp release that speaks relay protocol 2.6 and binds the login slug. */
export const WSMP_MIN_CLI_VERSION = "0.4.0";

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
