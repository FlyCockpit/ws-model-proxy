// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { variable?: string }) =>
      options?.variable ? `${key}:${options.variable}` : key,
  }),
}));

import { RequestSettingsFields } from "@/components/chat-test/request-settings";
import { DeploymentFeaturesPanel } from "@/components/deployment-features-panel";

const features = {
  MODEL_API_ANTHROPIC_ENABLED: false,
  MODEL_API_PROTOCOL_ADAPTATION_ENABLED: false,
  MODEL_API_GLOBAL_CAPACITY_ENABLED: false,
  WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: {
    enabled: false,
    keyringConfigured: false,
    ready: false,
  },
  WMP_MCP_ENABLED: false,
  WMP_MCP_PAT_ALLOW_NO_EXPIRY: true,
  WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: false,
  SIGNUP_ENABLED: false,
};

function renderSurface(isDeploymentAdmin: boolean) {
  return render(
    <RequestSettingsFields
      idPrefix="chat-test"
      isPool
      selectedModel={undefined}
      surfaceSelection="PREFERRED"
      effectiveSurface={null}
      recommendedSurface={null}
      routingMode="PREFER_NATIVE"
      selectorState={{ hidden: true }}
      effectiveReasoningSelection="unset"
      reasoningHelp=""
      anthropicMaxTokens={1024}
      onAnthropicMaxTokensChange={() => undefined}
      disabled={false}
      anthropicMessagesEnabled={false}
      isDeploymentAdmin={isDeploymentAdmin}
      onSurfaceChange={() => undefined}
      onRoutingModeChange={() => undefined}
      onReasoningChange={() => undefined}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("deployment feature gates", () => {
  it("keeps Anthropic Messages visible and disabled when the flag is off", () => {
    renderSurface(true);
    const option = screen.getByRole("option", {
      name: "dashboard:chatTest.surface.ANTHROPIC_MESSAGES",
    });
    expect(option).toBeTruthy();
    expect((option as HTMLOptionElement).disabled).toBe(true);
    expect(
      screen.getByText("dashboard:deploymentFeatures.adminEnable:MODEL_API_ANTHROPIC_ENABLED"),
    ).toBeTruthy();

    cleanup();
    renderSurface(false);
    expect(
      screen.getByRole("option", { name: "dashboard:chatTest.surface.ANTHROPIC_MESSAGES" }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("option", {
          name: "dashboard:chatTest.surface.ANTHROPIC_MESSAGES",
        }) as HTMLOptionElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("dashboard:deploymentFeatures.unavailable")).toBeTruthy();
  });

  it("lists every deployment flag on the admin panel, including the Anthropic variable", () => {
    render(<DeploymentFeaturesPanel features={features} />);
    for (const name of [
      "MODEL_API_ANTHROPIC_ENABLED",
      "MODEL_API_PROTOCOL_ADAPTATION_ENABLED",
      "MODEL_API_GLOBAL_CAPACITY_ENABLED",
      "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED",
      "keyringConfigured",
      "ready",
      "WMP_MCP_ENABLED",
      "WMP_MCP_PAT_ALLOW_NO_EXPIRY",
      "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS",
      "SIGNUP_ENABLED",
    ]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });
});
