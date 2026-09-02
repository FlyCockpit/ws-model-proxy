import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { os, type RouterClient } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { BatchHandlerPlugin } from "@orpc/server/plugins";
import { RPC_BATCH_MAX_SIZE } from "@ws-model-proxy/config/rpc-policy";
import { describe, expect, it } from "vitest";
import { createRpcBatchLinkPlugin } from "./rpc-batch-link";

const executed: string[] = [];
const procedure = (name: string) =>
  os.handler(() => {
    executed.push(name);
    return name;
  });
const router = {
  one: procedure("one"),
  two: procedure("two"),
  three: procedure("three"),
  four: procedure("four"),
  five: procedure("five"),
};

describe("RPC client batching", () => {
  it("splits five concurrent operations into batches of three and two", async () => {
    executed.length = 0;
    const handler = new RPCHandler(router, {
      plugins: [new BatchHandlerPlugin({ maxSize: RPC_BATCH_MAX_SIZE })],
    });
    const capturedBatches: Array<Array<{ url: string }>> = [];
    const link = new RPCLink({
      url: "https://example.test/rpc",
      plugins: [createRpcBatchLinkPlugin()],
      fetch: async (url, init) => {
        const request = new Request(url, init);
        expect(request.method).toBe("POST");
        expect(request.url.endsWith("/__batch__")).toBe(true);
        capturedBatches.push((await request.clone().json()) as Array<{ url: string }>);

        const result = await handler.handle(request, { prefix: "/rpc" });
        expect(result.matched).toBe(true);
        if (!result.matched) return new Response(null, { status: 404 });
        return result.response;
      },
    });
    const client = createORPCClient(link) as RouterClient<typeof router>;

    await expect(
      Promise.all([client.one(), client.two(), client.three(), client.four(), client.five()]),
    ).resolves.toEqual(["one", "two", "three", "four", "five"]);

    expect(capturedBatches).toHaveLength(2);
    expect(capturedBatches.map((batch) => batch.length)).toEqual([3, 2]);
    expect(capturedBatches.every((batch) => batch.length <= RPC_BATCH_MAX_SIZE)).toBe(true);
    expect(
      capturedBatches
        .flat()
        .map(({ url }) => new URL(url).pathname)
        .sort(),
    ).toEqual(["/rpc/five", "/rpc/four", "/rpc/one", "/rpc/three", "/rpc/two"]);
    expect(executed.sort()).toEqual(["five", "four", "one", "three", "two"]);
  });
});
