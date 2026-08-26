import { describe, expect, it } from "vitest";

import {
  allowsChatTestExecutionMode,
  resolveChatTestRoutingMode,
} from "./chat-test-routing-mode.js";

describe("chat test routing mode", () => {
  it("accepts explicit modes only for the cookie-authenticated chat test", () => {
    expect(resolveChatTestRoutingMode("REQUIRE_ADAPTED", true)).toBe("REQUIRE_ADAPTED");
    expect(resolveChatTestRoutingMode("REQUIRE_ADAPTED", false)).toBe("PREFER_NATIVE");
    expect(resolveChatTestRoutingMode("unknown", true)).toBe("PREFER_NATIVE");
  });

  it("fails closed to the requested execution class", () => {
    expect(allowsChatTestExecutionMode("REQUIRE_NATIVE", "native")).toBe(true);
    expect(allowsChatTestExecutionMode("REQUIRE_NATIVE", "adapted")).toBe(false);
    expect(allowsChatTestExecutionMode("REQUIRE_ADAPTED", "adapted")).toBe(true);
    expect(allowsChatTestExecutionMode("REQUIRE_ADAPTED", "native")).toBe(false);
    expect(allowsChatTestExecutionMode("REQUIRE_ADAPTED", "legacy")).toBe(false);
  });
});
