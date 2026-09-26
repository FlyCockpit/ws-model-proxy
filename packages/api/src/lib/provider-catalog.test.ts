import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogEntry } from "./fixtures/openrouter-catalog";

const egressMock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./provider-egress", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./provider-egress")>()),
  providerHttpsRequest: egressMock.request,
}));

const {
  CATALOG_MAX_BYTES,
  OPENROUTER_CATALOG_URL,
  ProviderCatalogFetchError,
  createProviderCatalog,
  fetchOpenRouterCatalogJson,
  readCappedBody,
} = await import("./provider-catalog");

const doc = (name = "Qwen") => ({ data: [catalogEntry({ name })] });

class FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  destroyed = false;
  constructor(statusCode = 200, headers: Record<string, string> = {}) {
    super();
    this.statusCode = statusCode;
    this.headers = headers;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  asMessage() {
    return this as unknown as IncomingMessage;
  }
}

describe("createProviderCatalog cache", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => {
    clock = 1_000_000;
  });

  it("returns disabled without fetching when the deployment switch is off", async () => {
    const fetchJson = vi.fn();
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => false, now });
    await expect(catalog.get()).resolves.toEqual({
      status: "disabled",
      reason: "EXTERNAL_PROVIDERS_DISABLED",
    });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("does not serve cached data once the switch is turned off", async () => {
    let on = true;
    const fetchJson = vi.fn(async () => doc());
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => on, now });
    expect((await catalog.get()).status).toBe("ok");
    on = false;
    expect((await catalog.get()).status).toBe("disabled");
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("serves the cache for 15 minutes, then refreshes", async () => {
    const fetchJson = vi.fn(async () => doc(`v${fetchJson.mock.calls.length}`));
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
    const first = await catalog.get();
    expect(first).toMatchObject({ status: "ok", stale: false });
    clock += 15 * 60_000 - 1;
    expect(await catalog.get()).toMatchObject({ status: "ok", stale: false });
    expect(fetchJson).toHaveBeenCalledTimes(1);
    clock += 1;
    const refreshed = await catalog.get();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(refreshed.status === "ok" && refreshed.models[0]?.name).toBe("v2");
  });

  it("shares one in-flight refresh between concurrent callers (single flight)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const fetchJson = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
    const calls = Promise.all([catalog.get(), catalog.get(), catalog.get()]);
    await Promise.resolve();
    release(doc());
    const results = await calls;
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.status === "ok")).toBe(true);
  });

  it("serves the last good copy as stale for 6 hours after a failed refresh", async () => {
    const fetchJson = vi.fn(async () => doc());
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
    await catalog.get();
    fetchJson.mockRejectedValue(new Error("boom"));
    clock += 15 * 60_000;
    expect(await catalog.get()).toMatchObject({ status: "ok", stale: true });
    clock += 6 * 60 * 60_000 - 1;
    expect(await catalog.get()).toMatchObject({ status: "ok", stale: true });
    clock += 1;
    expect(await catalog.get()).toEqual({ status: "unavailable", reason: "CATALOG_UNAVAILABLE" });
  });

  it("keeps the old copy when the new document is invalid", async () => {
    const fetchJson = vi.fn(async () => doc("good"));
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
    await catalog.get();
    fetchJson.mockResolvedValue({ data: [] });
    clock += 15 * 60_000;
    const result = await catalog.get();
    expect(result).toMatchObject({ status: "ok", stale: true });
    expect(result.status === "ok" && result.models[0]?.name).toBe("good");
  });

  it("reports unavailable with no cache and backs off 30 s before retrying", async () => {
    const fetchJson = vi.fn(async () => {
      throw new Error("down");
    });
    const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
    expect((await catalog.get()).status).toBe("unavailable");
    expect((await catalog.get()).status).toBe("unavailable");
    expect(fetchJson).toHaveBeenCalledTimes(1);
    clock += 30_000;
    fetchJson.mockResolvedValue(doc());
    expect((await catalog.get()).status).toBe("ok");
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  describe("deadline", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("aborts and fails a fetch that exceeds the 10 s deadline, even if it ignores the signal", async () => {
      let signal: AbortSignal | undefined;
      const fetchJson = vi.fn((received: AbortSignal) => {
        signal = received;
        return new Promise<unknown>(() => undefined);
      });
      const catalog = createProviderCatalog({ fetchJson, egressEnabled: () => true, now });
      const pending = catalog.get();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({
        status: "unavailable",
        reason: "CATALOG_UNAVAILABLE",
      });
      expect(signal?.aborted).toBe(true);
    });
  });
});

describe("readCappedBody", () => {
  const signal = () => new AbortController().signal;

  it("returns the full body under the cap", async () => {
    const response = new FakeResponse(200, { "content-length": "4" });
    const body = readCappedBody(response.asMessage(), 10, signal());
    response.emit("data", Buffer.from("ab"));
    response.emit("data", "cd");
    response.emit("end");
    await expect(body).resolves.toEqual(Buffer.from("abcd"));
  });

  it("fails and destroys the stream once the body exceeds the cap", async () => {
    const response = new FakeResponse();
    const body = readCappedBody(response.asMessage(), 3, signal());
    response.emit("data", Buffer.from("abcd"));
    await expect(body).rejects.toBeInstanceOf(ProviderCatalogFetchError);
    expect(response.destroyed).toBe(true);
  });

  it.each([
    ["non-200 status", new FakeResponse(500)],
    ["declared oversize body", new FakeResponse(200, { "content-length": "11" })],
    ["compressed body", new FakeResponse(200, { "content-encoding": "gzip" })],
  ])("rejects a %s before reading", async (_label, response) => {
    await expect(readCappedBody(response.asMessage(), 10, signal())).rejects.toBeInstanceOf(
      ProviderCatalogFetchError,
    );
    expect(response.destroyed).toBe(true);
  });

  it("fails when the deadline signal aborts mid-body or the stream errors", async () => {
    const controller = new AbortController();
    const response = new FakeResponse();
    const body = readCappedBody(response.asMessage(), 10, controller.signal);
    response.emit("data", Buffer.from("a"));
    controller.abort();
    await expect(body).rejects.toBeInstanceOf(ProviderCatalogFetchError);
    const errored = new FakeResponse();
    const second = readCappedBody(errored.asMessage(), 10, signal());
    errored.emit("error", new Error("reset"));
    await expect(second).rejects.toBeInstanceOf(ProviderCatalogFetchError);
  });
});

describe("fetchOpenRouterCatalogJson", () => {
  beforeEach(() => egressMock.request.mockReset());

  it("makes one keyless GET to the fixed public URL with private networks denied", async () => {
    const response = new FakeResponse(200, { "content-type": "application/json" });
    egressMock.request.mockResolvedValue(response.asMessage());
    const signal = new AbortController().signal;
    const pending = fetchOpenRouterCatalogJson(signal, { egressEnabled: true });
    await vi.waitFor(() => expect(egressMock.request).toHaveBeenCalled());
    response.emit("data", Buffer.from(JSON.stringify(doc())));
    response.emit("end");
    await expect(pending).resolves.toEqual(doc());
    expect(egressMock.request).toHaveBeenCalledTimes(1);
    const [url, options, policy, protocol, auth] = egressMock.request.mock.calls[0] ?? [];
    expect(url).toBe(OPENROUTER_CATALOG_URL);
    expect(options).toEqual({ method: "GET", headers: { accept: "application/json" }, signal });
    expect(policy).toEqual({ allowPrivateNetworks: false, egressEnabled: true, timeoutMs: 10_000 });
    expect(protocol).toBe("openai");
    expect(auth).toEqual({ type: "NONE", purpose: "UNAUTHENTICATED_PROBE" });
    expect(CATALOG_MAX_BYTES).toBe(4 * 1024 * 1024);
  });

  it("passes the switch through to the egress policy and maps bad JSON to a fetch error", async () => {
    const response = new FakeResponse();
    egressMock.request.mockResolvedValue(response.asMessage());
    const pending = fetchOpenRouterCatalogJson(new AbortController().signal, {
      egressEnabled: false,
    });
    await vi.waitFor(() => expect(egressMock.request).toHaveBeenCalled());
    response.emit("data", Buffer.from("{not json"));
    response.emit("end");
    await expect(pending).rejects.toBeInstanceOf(ProviderCatalogFetchError);
    expect(egressMock.request.mock.calls[0]?.[2]).toMatchObject({ egressEnabled: false });
  });
});
