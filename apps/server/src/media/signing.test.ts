import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));

const { buildSignedMediaUrl, verifyMediaSignature, MEDIA_SIGNATURE_TTL_MS } = await import(
  "./signing.js"
);

const BASE = "https://proxy.example.com";

describe("media signed URLs", () => {
  it("round-trips: a freshly built URL verifies", () => {
    const now = 1_700_000_000_000;
    const signed = buildSignedMediaUrl({ id: "asset123", publicBaseUrl: BASE, now });
    const url = new URL(signed.url);
    expect(url.pathname).toBe("/media/asset123");
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    expect(verifyMediaSignature({ id: "asset123", exp, sig, now: now + 1000 })).toEqual({
      ok: true,
    });
  });

  it("signatureExpiresAt reflects the TTL", () => {
    const now = 1_700_000_000_000;
    const signed = buildSignedMediaUrl({ id: "asset123", publicBaseUrl: BASE, now });
    const expected = new Date(
      Math.floor((now + MEDIA_SIGNATURE_TTL_MS) / 1000) * 1000,
    ).toISOString();
    expect(signed.signatureExpiresAt).toBe(expected);
  });

  it("rejects an expired signature", () => {
    const now = 1_700_000_000_000;
    const signed = buildSignedMediaUrl({ id: "asset123", publicBaseUrl: BASE, now, ttlMs: 1000 });
    const url = new URL(signed.url);
    const result = verifyMediaSignature({
      id: "asset123",
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
      now: now + 5000,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered id", () => {
    const now = 1_700_000_000_000;
    const signed = buildSignedMediaUrl({ id: "asset123", publicBaseUrl: BASE, now });
    const url = new URL(signed.url);
    const result = verifyMediaSignature({
      id: "other-asset",
      exp: url.searchParams.get("exp"),
      sig: url.searchParams.get("sig"),
      now: now + 1000,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered exp (extending the window)", () => {
    const now = 1_700_000_000_000;
    const signed = buildSignedMediaUrl({ id: "asset123", publicBaseUrl: BASE, now, ttlMs: 1000 });
    const url = new URL(signed.url);
    const forgedExp = String(Number(url.searchParams.get("exp")) + 10_000);
    const result = verifyMediaSignature({
      id: "asset123",
      exp: forgedExp,
      sig: url.searchParams.get("sig"),
      now: now + 5000,
    });
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a missing signature", () => {
    expect(verifyMediaSignature({ id: "x", exp: "123", sig: null })).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});
