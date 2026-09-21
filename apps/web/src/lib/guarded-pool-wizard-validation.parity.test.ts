import { suggestedConnectionSurfaces } from "@ws-model-proxy/api/lib/model-connection-type";
import {
  discoveredModelSurfaceCapabilities,
  providerModelSurfaceCapabilities,
} from "@ws-model-proxy/api/lib/pool-model-capabilities";
import {
  effectiveRecommendedSurface,
  primarySurfaceMatrices,
} from "@ws-model-proxy/api/lib/pool-recommended-surface";
import type { ModelApiSurface } from "@ws-model-proxy/api/lib/surface-capabilities";
import { describe, expect, it } from "vitest";
import {
  combinedPrimarySurfaceIsSelectable,
  type GuardedWizardLocalModel,
  localModelSurfaceCapabilities,
  primarySurfaceIsSelectable,
  recommendedCombinedPrimarySurface,
  recommendedPrimarySurface,
} from "./guarded-pool-wizard-validation";

/**
 * Parity matrix: the guarded wizard's member-capability resolution must equal
 * the server's canonical resolvers on the same inputs, so the wizard's
 * auto-set/auto-repair and the server's selectability gates can never
 * disagree. Two drift classes this matrix pins:
 * - legacy provider inventories (`{ surfaces: [...], streaming }` from older
 *   provider syncs) that the wizard's old parse-only composition dropped;
 * - OVERRIDE-mode discovered models where the old metadata-first composition
 *   ignored the server's override/endpoint precedence and coarse fallback.
 */

/** Server-side discovered-model row (Prisma model + Endpoint association). */
type DiscoveredRow = Parameters<typeof discoveredModelSurfaceCapabilities>[0];

/** Flattens a server row into the wizard's query projection shape. */
function toWizardModel(row: DiscoveredRow, id: string): GuardedWizardLocalModel {
  return {
    id,
    capabilityOverrideMode: row.capabilityOverrideMode,
    capabilityOverrideMetadata: row.capabilityOverrideMetadata,
    capabilityOverrides: row.capabilityOverrides,
    endpointCapabilityMetadata: row.Endpoint?.capabilityMetadata,
    endpointDefaultCapabilities: row.Endpoint?.defaultCapabilities,
    executionTarget: null,
  };
}

const v1Metadata = {
  version: 1 as const,
  protocol: "openai-compatible" as const,
  chatCompletions: { supported: true, streaming: true },
};
const v2Metadata = {
  version: 2 as const,
  protocol: "openai-compatible" as const,
  responses: { supported: true, streaming: true },
};
const v3Metadata = {
  version: 3 as const,
  protocol: "openai-compatible" as const,
  surfaces: {
    anthropicMessages: {
      source: "declared" as const,
      confidence: "exact" as const,
      supported: true,
      streaming: true,
    },
  },
};
const v4Metadata = {
  version: 4 as const,
  protocol: "openai-compatible" as const,
  surfaces: {
    openaiResponses: {
      source: "declared" as const,
      confidence: "exact" as const,
      streaming: true,
      operations: ["create" as const],
    },
  },
};

const discoveredCases: ReadonlyArray<[name: string, DiscoveredRow]> = [
  [
    "v1 endpoint metadata under INHERIT_ENDPOINT_DEFAULTS",
    { Endpoint: { capabilityMetadata: v1Metadata } },
  ],
  [
    "v2 override metadata under OVERRIDE",
    { capabilityOverrideMode: "OVERRIDE", capabilityOverrideMetadata: v2Metadata },
  ],
  [
    "v3 endpoint metadata under INHERIT_ENDPOINT_DEFAULTS",
    {
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      Endpoint: { capabilityMetadata: v3Metadata },
    },
  ],
  [
    "v4 override metadata under OVERRIDE",
    { capabilityOverrideMode: "OVERRIDE", capabilityOverrideMetadata: v4Metadata },
  ],
  [
    "coarse-only discovered model via endpoint defaults",
    { Endpoint: { defaultCapabilities: ["TEXT_GENERATION", "RESPONSES_API"] } },
  ],
  [
    "OVERRIDE with coarse overrides and no metadata",
    {
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrides: ["TEXT_GENERATION"],
      Endpoint: { defaultCapabilities: ["EMBEDDING"] },
    },
  ],
  [
    "OVERRIDE with parseable override beats parseable endpoint metadata",
    {
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: v2Metadata,
      Endpoint: { capabilityMetadata: v1Metadata },
    },
  ],
  [
    "INHERIT ignores leftover parseable override metadata",
    {
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      capabilityOverrideMetadata: v2Metadata,
      Endpoint: { capabilityMetadata: v1Metadata },
    },
  ],
  [
    "OVERRIDE with malformed metadata falls back to endpoint metadata",
    {
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: { version: 3, nonsense: true },
      Endpoint: { capabilityMetadata: v1Metadata },
    },
  ],
  [
    "OVERRIDE with malformed metadata and no endpoint metadata uses override coarse",
    {
      capabilityOverrideMode: "OVERRIDE",
      capabilityOverrideMetadata: "junk",
      capabilityOverrides: ["TEXT_GENERATION"],
      Endpoint: { capabilityMetadata: null, defaultCapabilities: ["EMBEDDING"] },
    },
  ],
  [
    "INHERIT with malformed endpoint metadata falls back to endpoint coarse",
    {
      capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS",
      Endpoint: { capabilityMetadata: { nope: 1 }, defaultCapabilities: ["TEXT_GENERATION"] },
    },
  ],
  [
    "unknown MERGE-style mode behaves like INHERIT (endpoint metadata wins)",
    {
      capabilityOverrideMode: "MERGE",
      capabilityOverrides: ["EMBEDDING"],
      Endpoint: { capabilityMetadata: v1Metadata, defaultCapabilities: ["EMBEDDING"] },
    },
  ],
  ["null and unparseable everywhere resolves to the empty coarse inventory", {}],
  [
    "null endpoint association",
    { capabilityOverrideMode: "INHERIT_ENDPOINT_DEFAULTS", Endpoint: null },
  ],
];

const providerCases: ReadonlyArray<[name: string, native: unknown]> = [
  ["v1 native inventory", v1Metadata],
  ["v2 native inventory", v2Metadata],
  ["v3 native inventory", v3Metadata],
  ["v4 native inventory", v4Metadata],
  [
    "legacy provider inventory single chat surface with streaming",
    { surfaces: ["openai-chat"], streaming: true },
  ],
  [
    "legacy provider inventory single responses surface without streaming",
    { surfaces: ["openai-responses"], streaming: false },
  ],
  [
    "legacy provider inventory anthropic surface",
    { surfaces: ["anthropic-messages"], streaming: true },
  ],
  [
    "legacy provider inventory multiple surfaces",
    { surfaces: ["openai-chat", "openai-responses"], streaming: true },
  ],
  [
    "legacy provider inventory completions-only surface",
    { surfaces: ["openai-completions"], streaming: false },
  ],
  [
    "legacy provider inventory with empty surfaces list is unparseable",
    { surfaces: [], streaming: true },
  ],
  [
    "legacy provider inventory with non-string surfaces entries is unparseable",
    { surfaces: [1, true], streaming: true },
  ],
  ["unparseable junk native inventory", "not-an-inventory"],
  ["null native inventory", null],
];

const surfaces = suggestedConnectionSurfaces as readonly ModelApiSurface[];

describe("guarded wizard / server capability-resolution parity", () => {
  it("resolves every discovered-model shape identically to discoveredModelSurfaceCapabilities", () => {
    for (const [name, row] of discoveredCases) {
      const wizard = localModelSurfaceCapabilities(toWizardModel(row, "model"));
      const server = discoveredModelSurfaceCapabilities(row);
      expect(wizard, name).toEqual(server);
    }
  });

  it("matches the server gate's per-surface selectability for every discovered-model shape", () => {
    for (const [name, row] of discoveredCases) {
      const model = toWizardModel(row, "model");
      const server = discoveredModelSurfaceCapabilities(row);
      for (const adaptationEnabled of [false, true]) {
        const [serverMatrix] = primarySurfaceMatrices({
          members: [{ tier: "PRIMARY", capabilities: server }],
          adaptationEnabled,
        });
        for (const surface of surfaces) {
          expect(
            primarySurfaceIsSelectable(surface, ["model"], [model], adaptationEnabled),
            `${name} / ${surface} / adaptation=${adaptationEnabled}`,
          ).toBe(serverMatrix[surface].mode !== "unavailable");
        }
      }
    }
  });

  it("matches the server gate's per-surface selectability for every provider shape", () => {
    for (const [name, native] of providerCases) {
      const provider = { id: "provider", nativeCapabilities: native };
      const server = providerModelSurfaceCapabilities(native);
      for (const adaptationEnabled of [false, true]) {
        const [serverMatrix] = primarySurfaceMatrices({
          members: [{ tier: "PRIMARY", capabilities: server }],
          adaptationEnabled,
        });
        for (const surface of surfaces) {
          expect(
            combinedPrimarySurfaceIsSelectable(
              surface,
              [],
              [],
              ["provider"],
              [provider],
              "PRIMARY",
              adaptationEnabled,
            ),
            `${name} / ${surface} / adaptation=${adaptationEnabled}`,
          ).toBe(serverMatrix[surface].mode !== "unavailable");
          // PUBLIC_OVERFLOW providers are not primary members: no gating.
          expect(
            combinedPrimarySurfaceIsSelectable(
              surface,
              [],
              [],
              ["provider"],
              [provider],
              "PUBLIC_OVERFLOW",
              adaptationEnabled,
            ),
            `${name} / overflow / ${surface}`,
          ).toBe(false);
        }
      }
    }
  });

  it("auto-sets a surface the server gate would keep servable for every shape", () => {
    // For each shape, when the wizard ranking picks a surface, that surface
    // must be servable according to the server's own matrices — i.e. the
    // wizard can never auto-set a surface the create/update gates reject.
    for (const [name, row] of discoveredCases) {
      const model = toWizardModel(row, "model");
      for (const adaptationEnabled of [false, true]) {
        const wizardPick = recommendedPrimarySurface(["model"], [model], adaptationEnabled);
        const [serverMatrix] = primarySurfaceMatrices({
          members: [{ tier: "PRIMARY", capabilities: discoveredModelSurfaceCapabilities(row) }],
          adaptationEnabled,
        });
        if (wizardPick)
          expect(
            serverMatrix[wizardPick].mode,
            `${name} / adaptation=${adaptationEnabled}`,
          ).not.toBe("unavailable");
      }
    }
    for (const [name, native] of providerCases) {
      const provider = { id: "provider", nativeCapabilities: native };
      for (const adaptationEnabled of [false, true]) {
        const wizardPick = recommendedCombinedPrimarySurface(
          [],
          [],
          ["provider"],
          [provider],
          "PRIMARY",
          adaptationEnabled,
        );
        const [serverMatrix] = primarySurfaceMatrices({
          members: [{ tier: "PRIMARY", capabilities: providerModelSurfaceCapabilities(native) }],
          adaptationEnabled,
        });
        if (wizardPick)
          expect(
            serverMatrix[wizardPick].mode,
            `${name} / adaptation=${adaptationEnabled}`,
          ).not.toBe("unavailable");
      }
    }
  });

  it("agrees with the server suggestion on single-surface shapes", () => {
    // The wizard's ranking (native count, then limitations, then order) is a
    // UI policy and may legitimately differ from the server's first-available
    // suggestion on multi-surface sets; on single-surface shapes both must
    // pick the same surface or both pick none.
    for (const [name, row] of discoveredCases) {
      const model = toWizardModel(row, "model");
      const serverMatrices = primarySurfaceMatrices({
        members: [{ tier: "PRIMARY", capabilities: discoveredModelSurfaceCapabilities(row) }],
        adaptationEnabled: false,
      });
      const serverSuggestion = effectiveRecommendedSurface({
        override: null,
        primaryMatrices: serverMatrices,
      });
      const wizardPick = recommendedPrimarySurface(["model"], [model], false);
      const selectable = surfaces.filter(
        (surface) => serverMatrices[0][surface].mode !== "unavailable",
      );
      if (selectable.length <= 1) {
        expect(wizardPick, name).toBe(selectable.length === 1 ? selectable[0] : null);
        expect(serverSuggestion, name).toBe(wizardPick);
      }
    }
  });
});
