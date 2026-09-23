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
      "inputDropped",
      "openElsewhere",
      "viewHere",
      "slowReconnecting",
      "actions",
      "endSession",
      "endSessionTitle",
      "endSessionDescription",
      "status.youTyping",
      "status.otherTyping",
      "status.viewers_one",
      "status.viewers_other",
      "status.following",
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
      "rejection.viewer_limit",
      "rejection.bad_frame",
      "rejection.identity_changed",
      "rejection.identity_invalid",
      "rejection.identity_mismatch",
      "identity.title",
      "identity.description",
      "identity.fingerprint",
      "identity.checking",
      "identity.offline",
      "identity.unpinned",
      "identity.unverified",
      "identity.invalid",
      "identity.changed",
      "identity.downgraded",
      "identity.pinned",
      "identity.new",
      "identity.trustNew",
      "identity.allowUnverified",
      "identity.trustTitle",
      "identity.trustDescription",
      "identity.trustFailed",
      "identity.activeUnverified",
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

  it("labels chat-test routing without a Chat-only API and as this test only", () => {
    expect(keyTree(esDashboard.chatTest.routingMode)).toEqual(
      keyTree(enDashboard.chatTest.routingMode),
    );
    expect(enDashboard.chatTest.routingMode).toEqual({
      label: "Chat test route",
      PREFER_NATIVE: "Try members that speak this API first",
      REQUIRE_NATIVE: "Only members that speak this API",
      REQUIRE_ADAPTED: "Only members that need translation",
      help: "Affects this chat test only. API clients such as OpenCode always try members that speak the requested API first, then translated members.",
      directHelp: "Direct models always use their own API. This control applies to pools.",
    });
    expect(esDashboard.chatTest.routingMode).toEqual({
      label: "Ruta de la prueba de chat",
      PREFER_NATIVE: "Probar primero los miembros que hablan esta API",
      REQUIRE_NATIVE: "Solo miembros que hablan esta API",
      REQUIRE_ADAPTED: "Solo miembros que necesitan traducción",
      help: "Afecta solo esta prueba de chat. Los clientes de API, como OpenCode, siempre prueban primero los miembros que hablan la API solicitada y después los miembros traducidos.",
      directHelp:
        "Los modelos directos siempre usan su propia API. Este control aplica a los pools.",
    });
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
