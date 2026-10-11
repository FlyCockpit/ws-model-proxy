import { createRouterClient, ORPCError, os } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { RETRY_CONFLICT_MESSAGE } from "../lib/refuse";
import { retryAnswers, untilAnswered } from "./retry-answers";

const retry = () => new ORPCError("CONFLICT", { message: RETRY_CONFLICT_MESSAGE });

describe("retry answers in the PostgreSQL suites", () => {
  it("retries the retry CONFLICT and a result named retry, then returns the answer", async () => {
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retry())
      .mockResolvedValueOnce("rate_limited")
      .mockResolvedValueOnce("ok");
    await expect(untilAnswered(write, (result) => result === "rate_limited")).resolves.toBe("ok");
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("never retries another answer", async () => {
    const named = new ORPCError("CONFLICT", {
      message: "Named.",
      data: { reason: "name_aliased" },
    });
    const write = vi.fn<() => Promise<string>>().mockRejectedValue(named);
    await expect(untilAnswered(write)).rejects.toBe(named);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("gives up with the last answer once its budget is spent", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn<() => Promise<string>>().mockRejectedValue(retry());
      const answered = untilAnswered(write, () => false, 500);
      const settled = expect(answered).rejects.toMatchObject({ code: "CONFLICT" });
      await vi.runAllTimersAsync();
      await settled;
      // Attempts at 0, 200 and 600 ms; the one past the 500 ms budget is the last.
      expect(write).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-runs a router client's procedure from the interceptor", async () => {
    const handler = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(retry())
      .mockResolvedValueOnce("written");
    const router = { write: os.handler(() => handler()) };
    const client = createRouterClient(router, { interceptors: [retryAnswers] });
    await expect(client.write()).resolves.toBe("written");
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
