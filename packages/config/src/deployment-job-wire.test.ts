import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isCanonicalBase64Url16 } from "./deployment-job-wire";

describe("canonical 16-byte base64url ids", () => {
  it("accepts every id the server and CLI mint", () => {
    for (let i = 0; i < 256; i++)
      expect(isCanonicalBase64Url16(randomBytes(16).toString("base64url"))).toBe(true);
    expect(isCanonicalBase64Url16("AAECAwQFBgcICQoLDA0ODw")).toBe(true);
  });

  it("refuses non-canonical trailing bits that Node would still decode", () => {
    const loose = "AAECAwQFBgcICQoLDA0ODx";
    expect(Buffer.from(loose, "base64url")).toHaveLength(16);
    expect(isCanonicalBase64Url16(loose)).toBe(false);
    for (const value of [
      "",
      "A".repeat(21),
      "A".repeat(23),
      `${"A".repeat(21)}=`,
      "A".repeat(21) + "+",
    ])
      expect(isCanonicalBase64Url16(value), value).toBe(false);
  });
});
