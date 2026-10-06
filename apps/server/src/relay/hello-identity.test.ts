import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com" },
}));

const {
  generateTestHelloIdentity,
  helloIdentityStatement,
  relayHelloOrigin,
  verifyHelloIdentitySignature,
} = await import("./hello-identity.js");

describe("hello identity statement", () => {
  const nonce = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const slug = "desktop";
  const origin = "https://proxy.example.com";

  it("mixes the server origin into the signed statement", () => {
    expect(relayHelloOrigin()).toBe(origin);
    const statement = helloIdentityStatement(nonce, slug, origin);
    // lp16("wsmp-relay-hello-v1") ‖ nonce(16) ‖ lp16("desktop") ‖ lp16(origin)
    expect(statement.subarray(0, 2).toString("hex")).toBe("0013");
    expect(statement.subarray(2, 21).toString("utf8")).toBe("wsmp-relay-hello-v1");
    expect(statement.subarray(21, 37).toString("hex")).toBe("000102030405060708090a0b0c0d0e0f");
    expect(statement.toString("hex")).toBe(
      "001377736d702d72656c61792d68656c6c6f2d7631000102030405060708090a0b0c0d0e0f00076465736b746f70001968747470733a2f2f70726f78792e6578616d706c652e636f6d",
    );
  });

  it("round-trips a signature and rejects a different origin", () => {
    const identity = generateTestHelloIdentity();
    const nonceB64 = nonce.toString("base64url");
    const signature = identity.sign(nonceB64, slug, origin);
    expect(
      verifyHelloIdentitySignature({
        identityPublicKey: identity.publicKey,
        signature,
        nonce: nonceB64,
        cliSlug: slug,
        origin,
      }),
    ).toBe(true);
    expect(
      verifyHelloIdentitySignature({
        identityPublicKey: identity.publicKey,
        signature,
        nonce: nonceB64,
        cliSlug: slug,
        origin: "http://localhost:3000",
      }),
    ).toBe(false);
  });
});
