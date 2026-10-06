import { describe, expect, it } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";
import enSettings from "../locales/en-US/settings.json";
import esDashboard from "../locales/es-MX/dashboard.json";
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
      "tokens.allowCliCommands",
      "tokens.allowCliFileRead",
      "tokens.allowCliFileReadHelp",
      "tokens.allowCliCommandsHelp",
      "tokens.allowCliCommandsBadge",
      "tokens.allowCliFileReadBadge",
      "tokens.allowCliCommandsNoExpiryWarning",
      "tokens.cliDevicesTitle",
      "tokens.cliDevicesHelp",
      "tokens.cliDevicesLoadFailed",
      "tokens.cliDevicesEmpty",
      "tokens.cliDevicesNoneAllow",
      "tokens.cliDeviceMode.off",
      "tokens.cliDeviceMode.supervised",
      "tokens.cliDeviceMode.unsupervised",
      "tokens.cliDeviceRefusal.grant_disabled",
      "tokens.cliDeviceRefusal.grant_supervised_only",
      "tokens.cliDeviceRefusal.cli_supervised_only",
      "tokens.cliDeviceRefusal.offline",
      "tokens.cliDeviceRefusal.feature_disabled",
      "tokens.cliDeviceRefusal.unsupported",
      "tokens.cliDeviceKind.headless",
      "tokens.cliDeviceKind.supervised",
      "tokens.cliDeviceAllowed",
      "tokens.cliDeviceGrantLink",
      "tokens.expiryLabel",
      "tokens.expiryHelp",
      "tokens.noExpiryOption",
      "tokens.days30",
      "tokens.days90",
      "tokens.days180",
      "tokens.days365",
      "tokens.customOption",
      "tokens.customDateLabel",
      "tokens.nameInvalid",
      "tokens.noExpiryDisabled",
      "tokens.expiryInvalid",
      "tokens.showRevoked",
      "tokens.revokedBadge",
      "tokens.expiredBadge",
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
      "tokens.edit",
      "tokens.editTitle",
      "tokens.editDescription",
      "tokens.editNarrowOnly",
      "tokens.save",
      "tokens.saving",
      "tokens.updated",
      "tokens.updateFailed",
      "tokens.updateForbidden",
      "tokens.lastUsed",
      "tokens.neverUsed",
      "tokens.expires",
      "tokens.noExpiry",
    ].sort();
    expect(keyTree(enSettings.mcp).sort()).toEqual(expected);
    expect(keyTree(esSettings.mcp).sort()).toEqual(expected);
  });

  it("names MCP command modes the same way the dashboard grant does", () => {
    for (const [settings, dashboard] of [
      [enSettings, enDashboard],
      [esSettings, esDashboard],
    ] as const) {
      expect(settings.mcp.tokens.cliDeviceMode.supervised).toBe(
        dashboard.clis.features.commandModes.supervised,
      );
      expect(settings.mcp.tokens.cliDeviceMode.unsupervised).toBe(
        dashboard.clis.features.commandModes.unsupervised,
      );
    }
  });
});
