import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => ({
  Prisma: (await import("../../../../packages/db/prisma/generated/client")).Prisma,
}));

const { attemptOutputTokens, providerBodyBillingBound, scaleProviderLiability } = await import(
  "./provider-billing-bound.js"
);

const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("provider body billing bound", () => {
  it("reads the candidate count from every field a provider bills by", () => {
    expect(providerBodyBillingBound(body({ max_tokens: 1000 }))).toEqual({
      bounded: true,
      outputTokens: 1000n,
      candidates: 1n,
    });
    expect(providerBodyBillingBound(body({ max_tokens: 1000, n: 16 }))).toMatchObject({
      candidates: 16n,
    });
    expect(providerBodyBillingBound(body({ n: 2, best_of: 5 }))).toMatchObject({ candidates: 5n });
    expect(providerBodyBillingBound(body({ num_return_sequences: 3 }))).toMatchObject({
      candidates: 3n,
    });
    expect(
      providerBodyBillingBound(
        body({ generationConfig: { candidateCount: 4, maxOutputTokens: 9 } }),
      ),
    ).toEqual({ bounded: true, outputTokens: 9n, candidates: 4n });
    expect(providerBodyBillingBound(body({ n: 0 }))).toMatchObject({ candidates: 1n });
    expect(providerBodyBillingBound(body({ n: null }))).toMatchObject({ candidates: 1n });
  });

  it("reads the llama.cpp, Ollama and TGI spellings, also inside their config objects", () => {
    expect(providerBodyBillingBound(body({ max_tokens: 100, n_cmpl: 16 }))).toMatchObject({
      outputTokens: 100n,
      candidates: 16n,
    });
    expect(providerBodyBillingBound(body({ max_tokens: 100, n_predict: 10_000 }))).toMatchObject({
      outputTokens: 10_000n,
    });
    expect(providerBodyBillingBound(body({ options: { num_predict: 500 } }))).toMatchObject({
      outputTokens: 500n,
    });
    expect(
      providerBodyBillingBound(body({ parameters: { max_new_tokens: 50, best_of: 3 } })),
    ).toMatchObject({ outputTokens: 50n, candidates: 3n });
    expect(providerBodyBillingBound(body({ CandidateCount: 2 }))).toMatchObject({ candidates: 2n });
    // "Unlimited" is no bound.
    expect(providerBodyBillingBound(body({ n_predict: -1 }))).toEqual({ bounded: false });
    expect(providerBodyBillingBound(body({ options: [] }))).toEqual({ bounded: false });
  });

  it("bounds an empty body (stored Responses retrieve, cancel, delete) by the request alone", () => {
    expect(providerBodyBillingBound(new Uint8Array())).toEqual({
      bounded: true,
      outputTokens: undefined,
      candidates: 1n,
    });
    expect(attemptOutputTokens(providerBodyBillingBound(new Uint8Array()), 0n)).toBe(0n);
  });

  it("takes the largest output limit under any field", () => {
    expect(
      providerBodyBillingBound(body({ max_tokens: 10, max_completion_tokens: 5000 })),
    ).toMatchObject({ outputTokens: 5000n });
    expect(providerBodyBillingBound(body({ max_output_tokens: 7 }))).toMatchObject({
      outputTokens: 7n,
    });
    expect(providerBodyBillingBound(body({ messages: [] }))).toMatchObject({
      outputTokens: undefined,
    });
  });

  it("cannot bound a count that is not a non-negative safe integer, or a non-object body", () => {
    for (const value of ["16", 1.5, -1, true, [2], { n: 2 }, 2 ** 60]) {
      expect(providerBodyBillingBound(body({ n: value }))).toEqual({ bounded: false });
      expect(providerBodyBillingBound(body({ max_tokens: value }))).toEqual({ bounded: false });
    }
    expect(providerBodyBillingBound(body({ generationConfig: "x" }))).toEqual({ bounded: false });
    expect(providerBodyBillingBound(body([]))).toEqual({ bounded: false });
    expect(providerBodyBillingBound(new Uint8Array([0xff, 0xfe]))).toEqual({ bounded: false });
  });

  it("reserves for the request's limit, or anything larger the body names", () => {
    const bound = providerBodyBillingBound(body({ max_completion_tokens: 2000 }));
    expect(attemptOutputTokens(bound, 1000n)).toBe(2000n);
    expect(attemptOutputTokens(bound, 3000n)).toBe(3000n);
    expect(attemptOutputTokens(providerBodyBillingBound(body({})), 1000n)).toBe(1000n);
    expect(attemptOutputTokens(providerBodyBillingBound(body({})), undefined)).toBeUndefined();
    expect(attemptOutputTokens({ bounded: false }, 1000n)).toBeUndefined();
  });

  it("scales the whole liability by the candidates, and refuses one that overflows", () => {
    const liability = { tokens: 1100n, spend: "0.0021", accountingVersion: "v1" };
    expect(scaleProviderLiability(liability, 1n)).toBe(liability);
    const scaled = scaleProviderLiability(liability, 16n);
    expect(scaled?.tokens).toBe(17_600n);
    expect(scaled?.spend?.toString()).toBe("0.0336");
    expect(scaleProviderLiability({ accountingVersion: "v1" }, 16n)).toEqual({
      accountingVersion: "v1",
      tokens: undefined,
      spend: undefined,
    });
    expect(
      scaleProviderLiability({ tokens: 2n ** 62n, accountingVersion: "v1" }, 4n),
    ).toBeUndefined();
  });
});
