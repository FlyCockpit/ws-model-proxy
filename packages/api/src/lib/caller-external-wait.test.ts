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
  const budget = 30_000;

  it("omits to the pool floor", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: null,
        requestExternalAfterWaitMs: undefined,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(pool);
  });

  it("lets a token or header lengthen past the pool floor up to the local wait budget", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 8_000,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(8_000);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 8_000,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(8_000);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 5_000,
        requestExternalAfterWaitMs: 8_000,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(8_000);
  });

  it("caps a lengthened wait at the local capacity wait budget", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 8_000,
        capacityWaitBudgetMs: 5_000,
      }),
    ).toBe(5_000);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 8_000,
        capacityWaitBudgetMs: 5_000,
      }),
    ).toBe(5_000);
  });

  it("does not cap at the budget when none is provided", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 8_000,
      }),
    ).toBe(8_000);
  });

  it("ignores shortening below the pool floor for owners and grantees", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 500,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 250,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(pool);
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        tokenExternalAfterWaitMs: 0,
        requestExternalAfterWaitMs: 0,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(pool);
  });

  it("lets a header lengthen when the token has no override", () => {
    expect(
      resolveCallerExternalAfterWaitMs({
        poolExternalAfterWaitMs: pool,
        requestExternalAfterWaitMs: 5_000,
        capacityWaitBudgetMs: budget,
      }),
    ).toBe(5_000);
  });
});
