import { AGENT_SCOPES } from "@ws-model-proxy/api/contracts";
import { describe, expect, it } from "vitest";
import { agentAccessPresets, matchAgentAccessPreset } from "./agent-access";

describe("agent access presets", () => {
  it("offers Read only, Run models and Full access when every scope is selectable", () => {
    expect(agentAccessPresets(AGENT_SCOPES)).toEqual([
      { id: "readOnly", scopes: ["read"] },
      { id: "models", scopes: ["read", "pools", "runtimes", "models:test"] },
      { id: "full", scopes: [...AGENT_SCOPES] },
    ]);
  });

  it("drops Run models when the ceiling lacks one of its scopes or equals it", () => {
    expect(agentAccessPresets(["read", "files"]).map((preset) => preset.id)).toEqual([
      "readOnly",
      "full",
    ]);
    expect(
      agentAccessPresets(["read", "pools", "runtimes", "models:test"]).map((preset) => preset.id),
    ).toEqual(["readOnly", "full"]);
  });

  it("offers no presets when only read is selectable", () => {
    expect(agentAccessPresets(["read"])).toEqual([]);
  });

  it("matches a scope set to its preset regardless of order, read implied", () => {
    expect(matchAgentAccessPreset([], AGENT_SCOPES)).toBe("readOnly");
    expect(matchAgentAccessPreset(["models:test", "runtimes", "pools"], AGENT_SCOPES)).toBe(
      "models",
    );
    expect(matchAgentAccessPreset([...AGENT_SCOPES].reverse(), AGENT_SCOPES)).toBe("full");
    expect(matchAgentAccessPreset(["read", "files"], AGENT_SCOPES)).toBeNull();
    expect(matchAgentAccessPreset(["read", "files"], ["read", "files"])).toBe("full");
  });
});
