import { describe, expect, it } from "vitest";
import enSettings from "../locales/en-US/settings.json";
import esSettings from "../locales/es-MX/settings.json";

/**
 * Key-tree parity for the settings namespace's Phase 7 MCP additions: both
 * bundles were authored together, so a missing key can never leak the en-US
 * fallback into an es-MX UI.
 */
function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("settings locale key parity (en-US / es-MX)", () => {
  it("has identical key trees for the MCP grant-management section and nav label", () => {
    expect(keyTree(esSettings.mcp)).toEqual(keyTree(enSettings.mcp));
    expect(esSettings.navMcp).toBeDefined();
    expect(enSettings.navMcp).toBeDefined();
  });

  it("contains the full MCP grant-management key set in both bundles", () => {
    const expected = [
      "title",
      "description",
      "empty",
      "loadFailed",
      "scopes",
      "noScopes",
      "firstAuthorized",
      "lastAuthorized",
      "rollingExpiry",
      "noActiveRefresh",
      "activeRefreshCount",
      "dpop.all",
      "dpop.some",
      "dpop.none",
      "revoke",
      "revokeTitle",
      "revokeDescription",
      "revokeConfirm",
      "revoking",
      "revoked",
      "revokeFailed",
      "tokens.title",
      "tokens.description",
      "tokens.empty",
      "tokens.loadFailed",
      "tokens.create",
      "tokens.createTitle",
      "tokens.createDescription",
      "tokens.createDisabled",
      "tokens.name",
      "tokens.allowWrite",
      "tokens.allowWriteHelp",
      "tokens.creating",
      "tokens.created",
      "tokens.createFailed",
      "tokens.capReached",
      "tokens.secret",
      "tokens.oneTimeHelp",
      "tokens.mcpUrl",
      "tokens.mcpUrlHelp",
      "tokens.grokConfig",
      "tokens.grokConfigHelp",
      "tokens.grokTemplate",
      "tokens.copy",
      "tokens.show",
      "tokens.hide",
      "tokens.revoke",
      "tokens.revokeTitle",
      "tokens.revokeDescription",
      "tokens.revokeConfirm",
      "tokens.revoking",
      "tokens.revoked",
      "tokens.revokeFailed",
      "tokens.lastUsed",
      "tokens.neverUsed",
      "tokens.expires",
      "tokens.noExpiry",
    ].sort();
    expect(keyTree(enSettings.mcp).sort()).toEqual(expected);
    expect(keyTree(esSettings.mcp).sort()).toEqual(expected);
  });
});
