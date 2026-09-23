import { modelApiSurfaces } from "@ws-model-proxy/api/lib/surface-capabilities";
import { describe, expect, it } from "vitest";
import enDashboard from "../locales/en-US/dashboard.json";
import esDashboard from "../locales/es-MX/dashboard.json";

/**
 * Key-tree parity for the dashboard models surface labels: the provider
 * operations form renders `dashboard:models.surfaces.${surface}` dynamically
 * from the ModelApiSurface union, so every value the type system allows must
 * have a key in both bundles or the raw key leaks into the UI.
 */
function keyTree(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, nested]) =>
    keyTree(nested, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("dashboard locale key parity (en-US / es-MX)", () => {
  it("has identical key trees for the models surfaces section", () => {
    expect(keyTree(esDashboard.models.surfaces)).toEqual(keyTree(enDashboard.models.surfaces));
  });

  it("contains the full models surfaces key set in both bundles", () => {
    const expected = ["ANTHROPIC_MESSAGES", "OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES"].sort();
    expect(keyTree(enDashboard.models.surfaces).sort()).toEqual(expected);
    expect(keyTree(esDashboard.models.surfaces).sort()).toEqual(expected);
  });

  it("has identical terminals, nav, and CLI feature keys", () => {
    expect(keyTree(esDashboard.terminals)).toEqual(keyTree(enDashboard.terminals));
    expect(keyTree(esDashboard.nav)).toEqual(keyTree(enDashboard.nav));
    expect(keyTree(esDashboard.clis.features)).toEqual(keyTree(enDashboard.clis.features));
  });

  it("contains the terminals and CLI feature keys in both bundles", () => {
    const terminalKeys = [
      "title",
      "description",
      "empty",
      "emptyClis",
      "loading",
      "add",
      "close",
      "cliList",
      "reconnecting",
      "exited",
      "rejected",
      "error",
      "approvalTitle",
      "approvalInstructions",
      "approvalCodeLabel",
      "copyCommand",
      "copied",
      "reasons.notGranted",
      "reasons.offline",
      "reasons.unavailable",
      "rejection.disabled",
      "rejection.unsupported",
      "rejection.limit",
      "rejection.approval_required",
      "rejection.bad_signature",
      "rejection.bad_handshake",
      "rejection.bad_cwd",
      "rejection.spawn_failed",
      "rejection.not_found",
      "rejection.already_open",
      "rejection.expired",
      "rejection.not_granted",
      "rejection.device_disabled",
      "rejection.cli_too_old",
      "rejection.offline",
      "rejection.invalid",
    ].sort();
    const featureKeys = [
      "terminal",
      "commands",
      "saved",
      "saveFailed",
      "windows",
      "configDisabled",
      "updateWsmp",
    ].sort();
    expect(keyTree(enDashboard.terminals).sort()).toEqual(terminalKeys);
    expect(keyTree(esDashboard.terminals).sort()).toEqual(terminalKeys);
    expect(keyTree(enDashboard.clis.features).sort()).toEqual(featureKeys);
    expect(keyTree(esDashboard.clis.features).sort()).toEqual(featureKeys);
    expect(enDashboard.nav.terminals).toBeTruthy();
    expect(esDashboard.nav.terminals).toBeTruthy();
    expect(enDashboard.nav.collapseSidebar).toBeTruthy();
    expect(esDashboard.nav.expandSidebar).toBeTruthy();
  });

  it("labels every surface the ModelApiSurface union allows", () => {
    for (const surface of modelApiSurfaces) {
      expect(enDashboard.models.surfaces, `en-US missing label for ${surface}`).toHaveProperty(
        surface,
      );
      expect(esDashboard.models.surfaces, `es-MX missing label for ${surface}`).toHaveProperty(
        surface,
      );
    }
  });
});
