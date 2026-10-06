import { randomBytes } from "node:crypto";
import { ENROLLMENT_CODE_PATTERN } from "../contracts/http";

export const ENROLLMENT_CODE_PREFIX = "wsmp_enr_";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** 26 base32 characters = 130 bits. */
const CODE_CHARS = 26;

/** RFC 4648 base32 (no padding) of `bytes`, cut to `length` characters. */
export function base32(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0 && out.length < length) out += BASE32[(buffer << (5 - bits)) & 31];
  if (out.length < length) throw new Error("Not enough random bytes for the code.");
  return out;
}

/** A fresh `wsmp_enr_` + 26 base32 characters (130 random bits). */
export function generateEnrollmentCode(): string {
  const code = `${ENROLLMENT_CODE_PREFIX}${base32(randomBytes(17), CODE_CHARS)}`;
  if (!ENROLLMENT_CODE_PATTERN.test(code)) throw new Error("Enrollment code shape.");
  return code;
}

/** The 8 characters after the prefix, kept for display. */
export function enrollmentCodePrefix(code: string): string {
  return code.slice(ENROLLMENT_CODE_PREFIX.length, ENROLLMENT_CODE_PREFIX.length + 8);
}

/**
 * The "Add a node" one-liner: install `wsmp`, then log in with the pre-approved code.
 *
 * TODO(cli/server): the install script (`/install.sh`) and `wsmp login --code` are built in the
 * CLI and server lanes; keep this text in step with them.
 */
export function enrollmentInstallCommand(origin: string, code: string): string {
  const base = origin.replace(/\/+$/, "");
  return `curl -fsSL ${base}/install.sh | sh && wsmp login ${base} --code ${code}`;
}
