import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ProtocolSurface } from "./canonical.js";
import {
  parseAnthropicMessagesRequest,
  parseOpenAiChatRequest,
  parseOpenAiResponsesRequest,
  parseProtocolResponse,
} from "./index.js";

describe("published-derived request/response/error fixtures", () => {
  it("conforms all three modern protocol surfaces", async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/generated-conformance/modern-nonstream.json", import.meta.url),
        "utf8",
      ),
    ) as {
      cases: Array<{
        surface: ProtocolSurface;
        request: unknown;
        response: unknown;
        errorStatus: number;
        error: unknown;
      }>;
    };
    expect(fixture.cases).toHaveLength(3);
    for (const protocol of fixture.cases) {
      const request =
        protocol.surface === "openai-chat"
          ? parseOpenAiChatRequest(protocol.request)
          : protocol.surface === "openai-responses"
            ? parseOpenAiResponsesRequest(protocol.request)
            : parseAnthropicMessagesRequest(protocol.request);
      expect(request.source).toBe(protocol.surface);
      expect(
        parseProtocolResponse({
          surface: protocol.surface,
          body: protocol.response,
          status: 200,
        }).ok,
      ).toBe(true);
      expect(
        parseProtocolResponse({
          surface: protocol.surface,
          body: protocol.error,
          status: protocol.errorStatus,
        }).ok,
      ).toBe(false);
    }
  });
});
