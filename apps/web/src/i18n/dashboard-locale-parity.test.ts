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

  it("has identical agent request keys, with every supervised status", () => {
    expect(keyTree(esDashboard.agentRequests)).toEqual(keyTree(enDashboard.agentRequests));
    const statuses = [
      "awaiting_user",
      "running",
      "awaiting_output_review",
      "exited",
      "declined",
      "expired",
      "cancelled",
      "rejected",
    ].sort();
    expect(Object.keys(enDashboard.agentRequests.status).sort()).toEqual(statuses);
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
      "cliSearch",
      "cliSearchEmpty",
      "reconnecting",
      "signedOut",
      "exited",
      "gone",
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
      "ending",
      "endFailed",
      "status.youTyping",
      "status.otherTyping",
      "status.viewers_one",
      "status.viewers_other",
      "status.following",
      "status.size",
      "phase.opening",
      "phase.live",
      "phase.rejected",
      "phase.exited",
      "phase.waiting",
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
      "rejection.rate_limited",
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
      "identity.invalid",
      "identity.changed",
      "identity.pinned",
      "identity.new",
      "identity.trustNew",
      "identity.trustTitle",
      "identity.trustDescription",
      "identity.trustFailed",
      "identity.keyChangedAgain",
      "identity.attention",
      "identity.review",
    ].sort();
    const featureKeys = [
      "terminal",
      "commands",
      "saved",
      "saveFailed",
      "windows",
      "configDisabled",
      "updateWsmp",
      "commandModes.off",
      "commandModes.supervised",
      "commandModes.unsupervised",
      "commandModeHelp.off",
      "commandModeHelp.supervised",
      "commandModeHelp.unsupervised",
      "commandModeRecommended",
      "effective",
      "commandSwitches",
      "commandRefusal.grant_disabled",
      "commandRefusal.grant_supervised_only",
      "commandRefusal.cli_supervised_only",
      "commandRefusal.offline",
      "commandRefusal.feature_disabled",
      "commandRefusal.unsupported",
      "commandKind.headless",
      "commandKind.supervised",
      "commandAllowed",
      "unsupervisedConfirm.title",
      "unsupervisedConfirm.description",
      "unsupervisedConfirm.cancel",
      "unsupervisedConfirm.confirm",
      "approvalRecommended",
    ].sort();
    expect(keyTree(enDashboard.terminals).sort()).toEqual(terminalKeys);
    expect(keyTree(esDashboard.terminals).sort()).toEqual(terminalKeys);
    expect(keyTree(enDashboard.clis.features).sort()).toEqual(featureKeys);
    expect(keyTree(esDashboard.clis.features).sort()).toEqual(featureKeys);
    expect(enDashboard.nav.terminals).toBeTruthy();
    expect(esDashboard.nav.terminals).toBeTruthy();
    expect(enDashboard.nav.collapseSidebar).toBeTruthy();
    expect(esDashboard.nav.expandSidebar).toBeTruthy();
    expect(enDashboard.nav.openTerminals).toBeTruthy();
    expect(esDashboard.nav.showTerminals).toBeTruthy();
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

  it("labels every chat-test fallback reason in both bundles", () => {
    // The chip renders `dashboard:chatTest.route.reasons.${reason}` for every
    // reason the model API may report; a missing key leaks the raw code into
    // the chip (`reasons.other` is the deliberate passthrough for unknowns).
    expect(keyTree(esDashboard.chatTest.route.reasons)).toEqual(
      keyTree(enDashboard.chatTest.route.reasons),
    );
    const reasons = [
      "local_wait_expired",
      "local_saturated_protected",
      "no_local_member",
      "local_context_ceiling",
      "local_failure",
      "other",
    ].sort();
    expect(keyTree(enDashboard.chatTest.route.reasons).sort()).toEqual(reasons);
    expect(keyTree(esDashboard.chatTest.route.reasons).sort()).toEqual(reasons);
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
  it("has identical overview key trees, covering every dynamic overview key", () => {
    expect(keyTree(esDashboard.overview)).toEqual(keyTree(enDashboard.overview));
    const overviewKeys = keyTree(enDashboard.overview);
    for (const status of ["UNKNOWN", "HEALTHY", "HALF_OPEN", "DEGRADED", "UNHEALTHY"])
      expect(overviewKeys).toContain(`pools.health.${status}`);
    for (const status of ["ACTIVE", "DRAINING", "DISABLED"])
      expect(overviewKeys).toContain(`pools.routing.${status}`);
    for (const tier of ["PRIMARY", "PUBLIC_OVERFLOW"])
      expect(overviewKeys).toContain(`pools.tier.${tier}`);
    for (const range of ["1h", "24h", "7d"]) expect(overviewKeys).toContain(`ranges.${range}`);
    for (const step of ["connectCli", "addEndpoint", "createPool", "createToken", "tryChat"])
      for (const field of ["title", "description", "action"])
        expect(overviewKeys).toContain(`setup.steps.${step}.${field}`);
    // Units and shared-pool labels come from the bundles, never literals.
    for (const key of ["kpi.deltaPoints", "shared.title", "shared.unavailable", "shared.owner"])
      expect(overviewKeys).toContain(key);
    for (const bundle of [enDashboard, esDashboard])
      expect(bundle.overview.kpi.deltaPoints).toContain("{{value}}");
  });

  it("no longer carries the removed shared dashboard header keys", () => {
    expect(enDashboard).not.toHaveProperty("title");
    expect(enDashboard).not.toHaveProperty("description");
    expect(esDashboard).not.toHaveProperty("title");
    expect(esDashboard).not.toHaveProperty("description");
  });
});

it("keeps external consent keys in sync and removes obsolete pool notices", () => {
  for (const key of ["pools", "tokens", "providers", "notices"] as const) {
    expect(keyTree(esDashboard[key]).sort()).toEqual(keyTree(enDashboard[key]).sort());
  }
  const keys = keyTree(enDashboard).join("\n");
  expect(keys).not.toMatch(
    /publicEgressAcknowledged|granteePrivacyConfirm|poolExternalProvider|acknowledgeEgress|providerTierDisclosure|egressWarning/,
  );
});

it("uses external-fallback wording, not egress or overflow, on the fallback surfaces", () => {
  // Display text only: the PUBLIC_OVERFLOW enum value and key names stay.
  const surfaces = (bundle: typeof enDashboard) => [
    bundle.pools.tabs,
    bundle.pools.fallbackBadge,
    bundle.pools.fallbackSettings,
    bundle.pools.fallbackEmpty,
    bundle.pools.fallbackDisabledDeployment,
    bundle.pools.memberTiers,
    bundle.pools.affinity.description,
    bundle.pools.wizard,
    bundle.overview.pools.tier,
    bundle.tokens,
  ];
  for (const [bundle, banned] of [
    [enDashboard, /egress|overflow|public (provider|target)/i],
    [esDashboard, /desbord|salida (a|pública)|(proveedor|destino)(es)? públic/i],
  ] as const) {
    // Values only (key names such as PUBLIC_OVERFLOW stay), minus the env var name.
    const text = leafValues(surfaces(bundle))
      .join("\n")
      .replaceAll("WMP_PUBLIC_PROVIDER_EGRESS_ENABLED", "");
    expect(text).not.toMatch(banned);
  }
  expect(enDashboard.pools.fallbackBadge.label).toBe("Fallback available");
  expect(enDashboard).not.toHaveProperty("pools.privacyBadge");
  expect(enDashboard.tokens.externalAccess.savedPoolsHint).not.toMatch(/first time/i);
  expect(keyTree(esDashboard.pools.fallbackBadge)).toEqual(
    keyTree(enDashboard.pools.fallbackBadge),
  );
});

function leafValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(leafValues);
}
