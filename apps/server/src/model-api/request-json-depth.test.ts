import { expect, it } from "vitest";
import { nestedWire } from "./cache-affinity-canonical.test-fixtures.js";
import { MAX_REQUEST_JSON_DEPTH, requestJsonDepthExceeded } from "./request-json-depth.js";

it("R4 pins literal request depth 256 and distinguishes scalar/container boundaries", () => {
  expect(MAX_REQUEST_JSON_DEPTH).toBe(256);
  for (const shape of ["array", "object", "mixed"] as const) {
    expect(requestJsonDepthExceeded(JSON.parse(nestedWire(256, shape)))).toBe(false);
    expect(requestJsonDepthExceeded(JSON.parse(nestedWire(257, shape)))).toBe(true);
    expect(requestJsonDepthExceeded(JSON.parse(nestedWire(10_000, shape)))).toBe(true);
  }
});

it("R4 scans 16M scalar entries without scalar wrappers or copies", () => {
  const wide = new Array(16_000_000).fill(0);
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  expect(requestJsonDepthExceeded(wide)).toBe(false);
  const elapsed = performance.now() - start;
  const growth = process.memoryUsage().heapUsed - before;
  console.info(
    `R4 depth smoke: 16M entries, ${Math.round(elapsed)} ms, heap delta ${(growth / 1024 / 1024).toFixed(1)} MiB`,
  );
  expect(growth).toBeLessThan(64 * 1024 * 1024);
  expect(elapsed).toBeLessThan(3000);
}, 10_000);
