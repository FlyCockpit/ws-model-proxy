import { describe, expect, it } from "vitest";
import {
  egressAcknowledgementIsValid,
  firstInvalidWizardField,
  guardedWizardStepCount,
  minimumSelectedPhysicalContext,
  primarySurfaceIsSelectable,
  providerOrderAfterMove,
  providerOrderAfterToggle,
  recommendedPrimarySurface,
} from "../lib/guarded-pool-wizard-validation";

const chatCapabilities = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, streaming: true },
};

describe("GuardedPoolSetupWizard flow", () => {
  it("has the complete four-step navigation contract", () => {
    expect(guardedWizardStepCount).toBe(4);
    expect([0, 1, 2, 3].map((step) => step + 1)).toEqual([1, 2, 3, 4]);
  });

  it("requires egress acknowledgement only when providers are selected", () => {
    expect(egressAcknowledgementIsValid([], false)).toBe(true);
    expect(egressAcknowledgementIsValid(["provider"], false)).toBe(false);
    expect(egressAcknowledgementIsValid(["provider"], true)).toBe(true);
  });

  it("returns the first invalid field for deterministic focus", () => {
    expect(
      firstInvalidWizardField(["slug", "name", "localModelIds"], {
        name: "required",
        localModelIds: "required",
      }),
    ).toBe("name");
  });

  it("preserves explicit provider order across selection and arrow moves", () => {
    const selected = providerOrderAfterToggle(["a"], "b", true);
    expect(selected).toEqual(["a", "b"]);
    expect(providerOrderAfterMove(selected, 1, -1)).toEqual(["b", "a"]);
    expect(providerOrderAfterToggle(["b", "a"], "b", false)).toEqual(["a"]);
  });

  it("prefers a native primary surface and rejects a merely adapted override", () => {
    const models = [{ id: "local", effectiveCapabilities: { metadata: chatCapabilities } }];
    expect(recommendedPrimarySurface(["local"], models)).toBe("OPENAI_CHAT_COMPLETIONS");
    expect(primarySurfaceIsSelectable("OPENAI_CHAT_COMPLETIONS", ["local"], models)).toBe(true);
    expect(primarySurfaceIsSelectable("OPENAI_RESPONSES", ["local"], models)).toBe(false);
  });

  it("uses the smallest selected physical context for inline validation", () => {
    const models = [
      { id: "a", executionTarget: { inferenceCapacityId: "cap-a" } },
      { id: "b", executionTarget: { inferenceCapacityId: "cap-b" } },
    ];
    expect(
      minimumSelectedPhysicalContext(["a", "b"], models, [
        { id: "cap-a", physicalMaxContext: 65_536 },
        { id: "cap-b", physicalMaxContext: 32_768 },
      ]),
    ).toBe(32_768);
  });
});
