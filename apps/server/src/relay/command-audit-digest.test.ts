import { createHash, createHmac, hkdfSync } from "node:crypto";
import {
  CLI_AGENT_ACTION_AUDIT_HASH_HEX_LENGTH,
  CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE,
  CLI_AGENT_ACTION_AUDIT_HKDF_INFO,
  commandAuditPath,
} from "@ws-model-proxy/config/cli-agent-audit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-better-auth-secret-value-32chars!";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));

const { env } = await import("@ws-model-proxy/env/server");
// The real env is readonly; the digest module reads env.BETTER_AUTH_SECRET, so
// the test mutates that one field to exercise two secrets and the missing case.
const mutableEnv = env as { BETTER_AUTH_SECRET: string };
const { commandAuditDigest, commandAuditDigestFor, deriveCommandAuditKey } = await import(
  "./command-audit-digest.js"
);

// Pinned vectors: the exact HKDF key and digest for SECRET. Every part of the
// derivation is fixed (HKDF-SHA256, empty salt, info label, 32 bytes), so any
// change to the label, hash, or salt fails here.
const PINNED_KEY_HEX = "c2045654516d4ca9abc68f35bdb7db77835b62974df15585e817441dba12248d";
const PINNED_DIGEST = "ed3bbaa09e0baf24459a78928c7c732f7887670afa1029655aba6341bf5400f9";

describe("deriveCommandAuditKey", () => {
  it("derives the pinned key from the fixed HKDF label", () => {
    expect(deriveCommandAuditKey(SECRET)?.toString("hex")).toBe(PINNED_KEY_HEX);
  });

  it("keeps the info label fixed", () => {
    expect(CLI_AGENT_ACTION_AUDIT_HKDF_INFO).toBe("wsmp-cli-agent-audit-v1");
    // A different label derives a different key: the label is doing the
    // domain separation, not the secret entropy alone.
    const other = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(SECRET, "utf8"),
        Buffer.alloc(0),
        "wsmp-cli-agent-audit-v2",
        32,
      ),
    );
    expect(other.toString("hex")).not.toBe(PINNED_KEY_HEX);
  });

  it("returns null without a usable secret, and never an unkeyed fallback", () => {
    expect(deriveCommandAuditKey("")).toBeNull();
    expect(deriveCommandAuditKey(undefined)).toBeNull();
    expect(deriveCommandAuditKey(null)).toBeNull();
  });
});

describe("commandAuditDigestFor", () => {
  it("is the pinned HMAC under the derived key", () => {
    expect(commandAuditDigestFor(SECRET)("mysql -pPassword1")).toBe(PINNED_DIGEST);
  });

  it("is stable for one secret and differs for another", () => {
    const a = commandAuditDigestFor(SECRET);
    expect(a("mysql -pPassword1")).toBe(a("mysql -pPassword1"));
    const b = commandAuditDigestFor("another-better-auth-secret-32-chars!!");
    expect(b("mysql -pPassword1")).not.toBe(a("mysql -pPassword1"));
  });

  it("returns the unavailable sentinel (not a bare hash) when there is no key", () => {
    const digest = commandAuditDigestFor("");
    expect(digest("mysql -pPassword1")).toBe(CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE);
    // It must not be the plain sha256 of the command.
    expect(digest("mysql -pPassword1")).not.toBe(
      createHash("sha256").update("mysql -pPassword1").digest("hex"),
    );
    expect(digest("mysql -pPassword1")).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays a hex HMAC-SHA256 for a present key", () => {
    expect(commandAuditDigestFor(SECRET)("pwd")).toBe(
      createHmac("sha256", Buffer.from(PINNED_KEY_HEX, "hex")).update("pwd").digest("hex"),
    );
  });
});

describe("commandAuditDigest (server)", () => {
  beforeEach(() => {
    mutableEnv.BETTER_AUTH_SECRET = SECRET;
  });

  it("keys by the server auth secret and caches per secret value", () => {
    expect(commandAuditDigest("mysql -pPassword1")).toBe(PINNED_DIGEST);
    expect(commandAuditDigest("mysql -pPassword1")).toBe(PINNED_DIGEST);
    mutableEnv.BETTER_AUTH_SECRET = "another-better-auth-secret-32-chars!!";
    expect(commandAuditDigest("mysql -pPassword1")).not.toBe(PINNED_DIGEST);
  });

  it("never leaks the raw secret or the derived key into the stored path", () => {
    const path = commandAuditPath("mysql -pPassword1 --host db", commandAuditDigest);
    expect(path).toMatch(
      new RegExp(`^hmac-sha256:[0-9a-f]{${CLI_AGENT_ACTION_AUDIT_HASH_HEX_LENGTH}} mysql$`),
    );
    expect(path).not.toContain(SECRET);
    expect(path).not.toContain(PINNED_KEY_HEX);
    expect(path).not.toContain("mysql -pPassword1");
  });

  it("degrades to the sentinel, without throwing, when the secret is missing", () => {
    mutableEnv.BETTER_AUTH_SECRET = "";
    expect(() => commandAuditDigest("pwd")).not.toThrow();
    expect(commandAuditPath("pwd", commandAuditDigest)).toBe("hmac-sha256:unavailable pwd");
  });
});
