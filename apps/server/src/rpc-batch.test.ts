import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RPC_BATCH_MAX_SIZE } from "@ws-model-proxy/config/rpc-policy";
import { describe, expect, it, vi } from "vitest";
import { createRpcBatchHandlerPlugin } from "./rpc-batch-plugin";

function createHarness() {
  const execute = vi.fn((name: string) => name);
  const procedure = (name: string) => os.handler(() => execute(name));
  const router = {
    one: procedure("one"),
    two: procedure("two"),
    three: procedure("three"),
    four: procedure("four"),
  };
  const handler = new RPCHandler(router, { plugins: [createRpcBatchHandlerPlugin()] });

  async function submitBatch(names: Array<keyof typeof router>) {
    const result = await handler.handle(
      new Request("https://example.test/rpc/__batch__", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-orpc-batch": "buffered",
        },
        body: JSON.stringify(
          names.map((name) => ({
            url: `https://example.test/rpc/${name}`,
            body: {},
          })),
        ),
      }),
      { prefix: "/rpc" },
    );
    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("Expected the batch route to match");
    return result.response;
  }

  return { execute, submitBatch };
}

describe("RPC server batch boundary", () => {
  it("accepts and executes exactly the configured maximum", async () => {
    const { execute, submitBatch } = createHarness();

    const response = await submitBatch(["one", "two", "three"]);

    expect(response.status).toBe(207);
    await expect(response.json()).resolves.toHaveLength(RPC_BATCH_MAX_SIZE);
    expect(execute).toHaveBeenCalledTimes(RPC_BATCH_MAX_SIZE);
  });

  it("rejects an oversized batch with 413 before any operation executes", async () => {
    const { execute, submitBatch } = createHarness();

    const response = await submitBatch(["one", "two", "three", "four"]);

    expect(response.status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });
});
