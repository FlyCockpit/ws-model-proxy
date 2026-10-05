import { describe, expect, it } from "vitest";
import { RELAY_SUBPROTOCOL } from "./relay/protocol.js";
import { selectWebSocketSubprotocol } from "./websocket-subprotocols.js";

describe("selectWebSocketSubprotocol", () => {
  it("selects the relay protocol only on the CLI path", () => {
    expect(selectWebSocketSubprotocol(new Set([RELAY_SUBPROTOCOL]), "/api/cli/ws")).toBe(
      RELAY_SUBPROTOCOL,
    );
    expect(selectWebSocketSubprotocol(new Set([RELAY_SUBPROTOCOL]), "/v1/realtime")).toBe(false);
  });

  it("selects realtime on /v1/realtime and never the key protocol", () => {
    const offered = new Set(["realtime", "openai-insecure-api-key.wsmp_model_secret"]);
    expect(selectWebSocketSubprotocol(offered, "/v1/realtime?intent=transcription")).toBe(
      "realtime",
    );
    expect(
      selectWebSocketSubprotocol(
        new Set(["openai-insecure-api-key.wsmp_model_secret"]),
        "/v1/realtime",
      ),
    ).toBe(false);
  });

  it("selects nothing elsewhere", () => {
    expect(selectWebSocketSubprotocol(new Set(["realtime"]), "/api/dashboard/terminal/ws")).toBe(
      false,
    );
    expect(selectWebSocketSubprotocol(new Set([RELAY_SUBPROTOCOL]), undefined)).toBe(false);
  });
});
