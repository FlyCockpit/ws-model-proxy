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
