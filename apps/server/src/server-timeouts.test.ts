import { describe, expect, it } from "vitest";
import {
  configureHttpServerTimeouts,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
} from "./server-timeouts.js";

describe("configureHttpServerTimeouts", () => {
  it("keeps reverse-proxy idle reuse inside Node's live socket window", () => {
    const server = { keepAliveTimeout: 5_000, headersTimeout: 60_000 };

    configureHttpServerTimeouts(server);

    expect(server).toEqual({
      keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
      headersTimeout: HTTP_HEADERS_TIMEOUT_MS,
    });
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});
