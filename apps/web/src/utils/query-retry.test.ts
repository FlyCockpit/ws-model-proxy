import { describe, expect, it } from "vitest";

import { shouldRetryQuery } from "./query-retry";

describe("shouldRetryQuery", () => {
  it.each([
    ["raw 413", { status: 413 }],
    ["structured 413", { code: "PAYLOAD_TOO_LARGE", status: 413 }],
    ["429", { status: 429 }],
    ["400", { status: 400 }],
    ["401", { status: 401 }],
    ["403", { status: 403 }],
    ["404", { status: 404 }],
    ["409", { status: 409 }],
    ["422", { status: 422 }],
    ["unknown", new Error("domain failure")],
  ])("does not retry browser %s errors", (_name, error) => {
    expect(shouldRetryQuery(0, error, false)).toBe(false);
  });

  it.each([
    ["408", { status: 408 }],
    ["500", { status: 500 }],
    ["503", { response: { status: 503 } }],
    ["nested cause", { cause: { status: 502 } }],
    ["fetch network", new TypeError("Failed to fetch")],
    ["network code", { code: "NETWORK_ERROR" }],
  ])("retries browser %s errors below the bound", (_name, error) => {
    expect(shouldRetryQuery(2, error, false)).toBe(true);
    expect(shouldRetryQuery(3, error, false)).toBe(false);
  });

  it.each([{ status: 408 }, { status: 413 }, { status: 503 }, { code: "NETWORK_ERROR" }])(
    "never retries during SSR",
    (error) => expect(shouldRetryQuery(0, error, true)).toBe(false),
  );

  it("does not mutate, wrap, or replace the error", () => {
    const cause = { status: 413 };
    const error = { cause, marker: Symbol("identity") };
    const before = { ...error };

    expect(shouldRetryQuery(0, error, false)).toBe(false);
    expect(error).toEqual(before);
    expect(error.cause).toBe(cause);
  });
});
