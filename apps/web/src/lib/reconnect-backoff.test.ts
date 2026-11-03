import { describe, expect, it } from "vitest";

import {
  INITIAL_RECONNECT_BACKOFF,
  planReconnect,
  type ReconnectBackoff,
  reconnectDelayMs,
} from "./reconnect-backoff";

const noJitter = () => 0;

describe("reconnectDelayMs", () => {
  it("doubles from 0.5 s to 15 s, plus up to 250 ms of jitter", () => {
    expect([0, 1, 2, 5, 10].map((attempt) => reconnectDelayMs(attempt, noJitter))).toEqual([
      500, 1_000, 2_000, 15_000, 15_000,
    ]);
    expect(reconnectDelayMs(0, () => 0.999)).toBe(749);
  });
});

describe("planReconnect", () => {
  it("backs off attempts that never opened", () => {
    let backoff: ReconnectBackoff = INITIAL_RECONNECT_BACKOFF;
    const delays: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      const plan = planReconnect(backoff, null, 30_000, noJitter);
      delays.push(plan.delayMs);
      backoff = plan.backoff;
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000]);
    expect(backoff).toEqual({ attempt: 4 });
  });

  it("keeps backing off a connection that closed before it was stable", () => {
    expect(planReconnect({ attempt: 3 }, 29_999, 30_000, noJitter)).toEqual({
      delayMs: 4_000,
      backoff: { attempt: 4 },
    });
  });

  it("resets after a connection that stayed open for the stable time", () => {
    expect(planReconnect({ attempt: 6 }, 30_000, 30_000, noJitter)).toEqual({
      delayMs: 500,
      backoff: { attempt: 1 },
    });
  });
});
