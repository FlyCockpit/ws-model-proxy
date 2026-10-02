import { describe, expect, it } from "vitest";
import {
  EXTERNAL_AFTER_WAIT_MS_MAX,
  parseExternalAfterWaitMs,
  resolveCallerExternalAfterWaitMs,
} from "./caller-external-wait";

describe("parseExternalAfterWaitMs", () => {
  it("omits empty, non-integer, and negative values", () => {
    expect(parseExternalAfterWaitMs(undefined)).toBeUndefined();
    expect(parseExternalAfterWaitMs(null)).toBeUndefined();
    expect(parseExternalAfterWaitMs("")).toBeUndefined();
    expect(parseExternalAfterWaitMs("  ")).toBeUndefined();
    expect(parseExternalAfterWaitMs("2_000")).toBeUndefined();
    expect(parseExternalAfterWaitMs("500.5")).toBeUndefined();
    expect(parseExternalAfterWaitMs("-1")).toBeUndefined();
    expect(parseExternalAfterWaitMs(-1)).toBeUndefined();
    expect(parseExternalAfterWaitMs(1.5)).toBeUndefined();
  });

  it("accepts whole milliseconds and clamps to the shared ceiling", () => {
    expect(parseExternalAfterWaitMs("0")).toBe(0);
    expect(parseExternalAfterWaitMs(" 500 ")).toBe(500);
    expect(parseExternalAfterWaitMs(2_000)).toBe(2_000);
    expect(parseExternalAfterWaitMs(String(EXTERNAL_AFTER_WAIT_MS_MAX + 1))).toBe(
      EXTERNAL_AFTER_WAIT_MS_MAX,
    );
    expect(parseExternalAfterWaitMs(EXTERNAL_AFTER_WAIT_MS_MAX + 5)).toBe(
      EXTERNAL_AFTER_WAIT_MS_MAX,
    );
  });
});

describe("resolveCallerExternalAfterWaitMs", () => {
  const pool = 2_000;

  it("omits to the pool default", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        isPoolOwner: true,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: null,
        requestExternalAfterWaitMs: undefined,
        isPoolOwner: false,
      }),
    ).toBe(pool);
  });

  it("caps the token and header at the pool value", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 8_000,
        isPoolOwner: true,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 8_000,
        isPoolOwner: true,
      }),
    ).toBe(pool);
  });

  it("lets an owner shorten via token or header, and never exceed the token cap", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 500,
        isPoolOwner: true,
      }),
    ).toBe(500);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 250,
        isPoolOwner: true,
      }),
    ).toBe(250);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 500,
        requestExternalAfterWaitMs: 8_000,
        isPoolOwner: true,
      }),
    ).toBe(500);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 500,
        requestExternalAfterWaitMs: 100,
        isPoolOwner: true,
      }),
    ).toBe(100);
  });

  it("lets a header lengthen up to the pool cap when the token has no override", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 1_500,
        isPoolOwner: true,
      }),
    ).toBe(1_500);
  });

  it("ignores a grantee shortening below the pool default", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 0,
        requestExternalAfterWaitMs: 0,
        isPoolOwner: false,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 500,
        isPoolOwner: false,
      }),
    ).toBe(pool);
  });

  it("caps a grantee lengthening at the pool value", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 8_000,
        requestExternalAfterWaitMs: 8_000,
        isPoolOwner: false,
      }),
    ).toBe(pool);
  });
});
