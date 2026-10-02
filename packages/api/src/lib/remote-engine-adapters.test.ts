import { describe, expect, it } from "vitest";
import {
  adapterRouteIsValid,
  canonicalRemoteEngineAdapterJson,
  parseStoredRemoteEngineAdapters,
  remoteEngineAdapterDefinitionsSchema,
  remoteEngineAdapterSpecSha256,
  serializeRemoteEngineAdapters,
} from "./remote-engine-adapters";

const adapter = {
  endpointSlug: "gpu",
  input: { command: "echo 1" },
  format: "json" as const,
  intervalSecs: 2,
  timeoutSecs: 2,
};

describe("remote engine adapter definitions", () => {
  it("rejects duplicate slugs, bad routes, prometheus without a map, and blank commands", () => {
    expect(remoteEngineAdapterDefinitionsSchema.safeParse([adapter, adapter]).success).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([
        { ...adapter, input: { route: "http://127.0.0.1/metrics" } },
      ]).success,
    ).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([
        { ...adapter, format: "prometheus", map: {} },
      ]).success,
    ).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([{ ...adapter, input: { command: "   " } }])
        .success,
    ).toBe(false);
    expect(parseStoredRemoteEngineAdapters([adapter])).toEqual([adapter]);
    expect(parseStoredRemoteEngineAdapters("garbage")).toEqual([]);
  });

  it("pins SHA-256 of the canonical spec including input and map", () => {
    expect(adapterRouteIsValid("/metrics")).toBe(true);
    expect(adapterRouteIsValid("/v1/load")).toBe(true);
    expect(adapterRouteIsValid("metrics?x=1")).toBe(false);
    const json = canonicalRemoteEngineAdapterJson(adapter);
    expect(json).toBe(
      '{"endpointSlug":"gpu","format":"json","input":{"command":"echo 1"},"intervalSecs":2,"map":{},"timeoutSecs":2}',
    );
    expect(remoteEngineAdapterSpecSha256(adapter)).toMatch(/^[0-9a-f]{64}$/);
    const mapped = {
      ...adapter,
      format: "prometheus" as const,
      input: { route: "/metrics" },
      map: { running: { series: "my_running", scale: 1 } },
    };
    const hashed = serializeRemoteEngineAdapters([mapped]);
    expect(hashed[0]?.specSha256).toBe(remoteEngineAdapterSpecSha256(mapped));
    expect(hashed[0]?.specSha256).not.toBe(remoteEngineAdapterSpecSha256(adapter));
  });

  it("rejects adapter routes that can leave the endpoint origin", () => {
    expect(adapterRouteIsValid("https:evil.example/x")).toBe(false);
    expect(adapterRouteIsValid("/\t/evil.example/x")).toBe(false);
    expect(adapterRouteIsValid("http:foo")).toBe(false);
    expect(adapterRouteIsValid(" /abs")).toBe(false);
    expect(adapterRouteIsValid("foo/bar")).toBe(false);
    expect(adapterRouteIsValid("//evil.example/x")).toBe(false);
    expect(adapterRouteIsValid("metrics")).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([
        { ...adapter, input: { route: "https:evil.example/x" } },
      ]).success,
    ).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([
        { ...adapter, input: { route: "/\t/evil.example/x" } },
      ]).success,
    ).toBe(false);
    expect(
      remoteEngineAdapterDefinitionsSchema.safeParse([{ ...adapter, input: { route: "/metrics" } }])
        .success,
    ).toBe(true);
  });
});
