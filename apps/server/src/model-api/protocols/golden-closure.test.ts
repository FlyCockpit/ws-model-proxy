import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AdapterError, parseOpenAiChatRequest, renderAnthropicMessagesRequest } from "./index.js";

describe("adapter golden behavior", () => {
  it("executes the pinned instruction-collapse rejection and opt-in output", async () => {
    const golden = JSON.parse(
      await readFile(
        new URL("./fixtures/adapter-golden/instruction-collapse-v1.json", import.meta.url),
        "utf8",
      ),
    ) as {
      sourceInstructions: Array<{ role: "system" | "developer"; text: string }>;
      strictResult: string;
      lossyOptInAnthropicSystem: Array<{ type: "text"; text: string }>;
      limitation: string;
    };
    const canonical = parseOpenAiChatRequest({
      model: "m",
      messages: golden.sourceInstructions.map((item) => ({
        role: item.role,
        content: item.text,
      })),
    });
    try {
      renderAnthropicMessagesRequest(canonical, "claude");
      throw new Error("expected strict rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe(golden.strictResult);
    }
    expect(
      renderAnthropicMessagesRequest(canonical, "claude", {
        allowLossyInstructionRoleCollapse: true,
      }).system,
    ).toEqual(golden.lossyOptInAnthropicSystem);
    expect(canonical.limitations).toContain(golden.limitation);
  });
});
