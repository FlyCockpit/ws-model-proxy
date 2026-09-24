/**
 * CLI device naming. A device has three names, each with one owner:
 *
 * - `slug`: chosen at `wsmp login`, unique per user, used in model ids and
 *   signed by the terminal identity statement.
 * - `reportedHostname`: what the CLI reports in every relay hello. A fact
 *   about the machine, never set by the user.
 * - `name`: set by the user in the dashboard. Hello never writes it.
 *
 * Every surface shows `cliDeviceDisplayName`, never one of these directly.
 */

/** Longest user-set device name, in characters. */
export const CLI_DEVICE_NAME_MAX_LENGTH = 120;

/** Longest stored reported hostname, in characters (a DNS name is ≤ 253). */
export const CLI_DEVICE_HOSTNAME_MAX_LENGTH = 253;

export type CliDeviceNameFields = {
  name?: string | null;
  reportedHostname?: string | null;
  slug: string;
};

function present(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** The one display-name rule: the user's name, else the hostname, else the slug. */
export function cliDeviceDisplayName(device: CliDeviceNameFields): string {
  return present(device.name) ?? present(device.reportedHostname) ?? device.slug;
}

/**
 * Control (`Cc`) and format (`Cf`) characters. They are invisible or change
 * how surrounding text renders (bidi overrides, zero-width characters), so a
 * device name or hostname containing them could spoof another device.
 *
 * Policy: a reported hostname is a fact the CLI sends, so these characters are
 * stripped (`normalizeReportedHostname`). A user-set name is typed on purpose,
 * so it is rejected instead (`cliDeviceNameIssue`). The Rust CLI mirrors the
 * hostname rule in `apps/cli/src/hostname.rs`.
 */
const INVISIBLE_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Why a user-set device name is invalid, or null when it is valid. */
export type CliDeviceNameIssue = "empty" | "tooLong" | "invisibleCharacters";

/**
 * Validates an already-trimmed user-set device name: 1..120 characters (code
 * points) with no control or format characters.
 */
export function cliDeviceNameIssue(name: string): CliDeviceNameIssue | null {
  if (name.length === 0) return "empty";
  if (INVISIBLE_CHARACTER.test(name)) return "invisibleCharacters";
  if (Array.from(name).length > CLI_DEVICE_NAME_MAX_LENGTH) return "tooLong";
  return null;
}

/**
 * A reported hostname as stored: control and format characters stripped,
 * trimmed, and bounded. Null when nothing usable remains.
 */
export function normalizeReportedHostname(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = Array.from(raw.replace(INVISIBLE_CHARACTERS, "").trim())
    .slice(0, CLI_DEVICE_HOSTNAME_MAX_LENGTH)
    .join("")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Whether a CLI device matches a search. Matches the display name (which
 * covers the user's name), the reported hostname, and the slug, so a device
 * is findable by any name it has. A blank query matches everything.
 */
export function cliDeviceMatchesSearch(
  device: {
    displayName?: string | null;
    reportedHostname?: string | null;
    slug?: string | null;
  },
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [device.displayName, device.reportedHostname, device.slug].some(
    (value) => typeof value === "string" && value.toLocaleLowerCase().includes(needle),
  );
}
