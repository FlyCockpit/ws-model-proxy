// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatRouteInfo } from "./chat-test-types";
import { RouteChip } from "./route-chip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options ? `${key}(${Object.values(options).join(",")})` : key,
  }),
}));

afterEach(cleanup);

const base: ChatRouteInfo = {
  route: null,
  servedModel: null,
  fallbackReason: null,
  externalUnavailable: false,
};

describe("RouteChip", () => {
  it("shows Local without a reason", () => {
    render(<RouteChip route={{ ...base, route: "local" }} />);
    expect(screen.getByText("dashboard:chatTest.route.local")).toBeTruthy();
    expect(screen.queryByText(/reasonLabel/)).toBeNull();
    expect(screen.getByTestId("chat-route").getAttribute("data-route")).toBe("local");
  });

  it("shows pool fallback with the served model and an inline, touch-readable reason", () => {
    render(
      <RouteChip
        route={{
          ...base,
          route: "pool-fallback",
          servedModel: "openai/gpt-4o-mini",
          fallbackReason: "local_wait_expired",
        }}
      />,
    );
    expect(
      screen.getByText("dashboard:chatTest.route.poolFallback(openai/gpt-4o-mini)"),
    ).toBeTruthy();
    const reason = screen.getByText(
      "dashboard:chatTest.route.reasonLabel(dashboard:chatTest.route.reasons.local_wait_expired)",
    );
    expect(reason).toBeTruthy();
    // The reason is visible text, never hidden behind a hover-only title.
    expect(screen.getByTestId("chat-route").querySelector("[title]")).toBeNull();
  });

  it("translates the protected-saturation reason instead of showing its raw code", () => {
    render(
      <RouteChip
        route={{
          ...base,
          route: "pool-fallback",
          servedModel: "openai/gpt-4o-mini",
          fallbackReason: "local_saturated_protected",
        }}
      />,
    );
    expect(
      screen.getByText(
        "dashboard:chatTest.route.reasonLabel(dashboard:chatTest.route.reasons.local_saturated_protected)",
      ),
    ).toBeTruthy();
  });

  it("shows own key with the served model and an unknown reason as raw text", () => {
    render(
      <RouteChip
        route={{
          ...base,
          route: "own-key",
          servedModel: "anthropic/claude-sonnet",
          fallbackReason: "something_new",
        }}
      />,
    );
    expect(
      screen.getByText("dashboard:chatTest.route.ownKey(anthropic/claude-sonnet)"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "dashboard:chatTest.route.reasonLabel(dashboard:chatTest.route.reasons.other(something_new))",
      ),
    ).toBeTruthy();
  });

  it("shows External unavailable alone and next to a local route", () => {
    const { rerender } = render(<RouteChip route={{ ...base, externalUnavailable: true }} />);
    expect(screen.getByText("dashboard:chatTest.route.externalUnavailable")).toBeTruthy();
    expect(screen.queryByText("dashboard:chatTest.route.local")).toBeNull();
    rerender(<RouteChip route={{ ...base, route: "local", externalUnavailable: true }} />);
    expect(screen.getByText("dashboard:chatTest.route.local")).toBeTruthy();
    expect(screen.getByText("dashboard:chatTest.route.externalUnavailable")).toBeTruthy();
  });
});
