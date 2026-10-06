import { describe, expect, it } from "vitest";
import { normalizeIdentityPublicKey } from "./cli-identity-key";

function identityKey(prefix = 0x04, fill = 0x11): string {
  const bytes = Buffer.alloc(65, fill);
  bytes[0] = prefix;
  return bytes.toString("base64url");
}

describe("normalizeIdentityPublicKey", () => {
  it("accepts an uncompressed P-256 point", () => {
    const key = identityKey();
    expect(key).toHaveLength(87);
    expect(normalizeIdentityPublicKey(` ${key} `)).toBe(key);
  });

  it.each([
    "",
    "   ",
    "not-a-key",
    identityKey(0x02),
    identityKey().slice(0, 86),
    `${identityKey()}aa`,
  ])("rejects %j", (raw) => {
    expect(normalizeIdentityPublicKey(raw)).toBeNull();
  });
});
