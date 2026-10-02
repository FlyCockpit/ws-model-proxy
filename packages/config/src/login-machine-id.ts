/**
 * Login-time machine id for a CLI device credential.
 *
 * `wsmp login` reads `/etc/machine-id` (or, when that file is missing or not a
 * machine id, a UUID the CLI generated beside the credential). The exchange
 * stores that value on the credential. Every later hello must present the same
 * id. Hostname stays a display label: `hostnamectl` can change it, and copying
 * `device-auth.json` onto another machine must not hello as the first device.
 *
 * The Rust CLI parses with the same rules (`apps/cli/src/machine_id.rs`).
 */

/** systemd machine-id: 32 lowercase hex digits, not all zeros. */
const MACHINE_ID_PATTERN = /^[0-9a-f]{32}$/;
/** Canonical UUID text (any version), lowercase. The nil UUID is refused. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * What a copied credential's hello is told. Printed by wsmp before it exits.
 * Re-login mints a credential bound to the machine that is actually running.
 */
export const DEVICE_CREDENTIAL_MACHINE_MISMATCH_MESSAGE =
  "This device credential is bound to another machine. Run `wsmp login` on this machine.";

/**
 * Normalize a login machine id, or null when it is not a machine-id or UUID.
 * Trims and lowercases. All-zero ids are refused (unset systemd machine-id,
 * nil UUID).
 */
export function normalizeLoginMachineId(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (MACHINE_ID_PATTERN.test(value)) {
    return /^0+$/.test(value) ? null : value;
  }
  if (UUID_PATTERN.test(value) && value !== NIL_UUID) return value;
  return null;
}
