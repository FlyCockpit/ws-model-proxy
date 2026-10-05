// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const needs = vi.hoisted(() => ({
  items: [] as Array<{
    id: string;
    endpointSlug: string;
    needsOperator: "STEP" | "RESTART";
    needsOperatorSince: string;
  }>,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.endpoint ? `${key}:${String(options.endpoint)}` : key,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => (
    <a href="/en-US/dashboard/deployments">{children}</a>
  ),
}));
vi.mock("@/hooks/use-deployment-operator-needs", () => ({
  useDeploymentOperatorNeeds: () => ({ count: needs.items.length, items: needs.items }),
}));

import { DeploymentNeedsBadge, DeploymentOperatorNotice } from "./deployment-operator-notice";

afterEach(() => {
  cleanup();
  needs.items = [];
});

describe("deployment needs-you notice", () => {
  it("renders nothing while no deployment waits", () => {
    const { container } = render(<DeploymentOperatorNotice lang="en-US" />);
    expect(container.innerHTML).toBe("");
    render(<DeploymentNeedsBadge count={0} />);
    expect(screen.queryByText("dashboard:deploymentOperator.badge")).toBeNull();
  });

  it("names the deployment, links to Deployments, and stays dismissed until a new need", async () => {
    needs.items = [
      {
        id: "i1",
        endpointSlug: "inst-‮qwen",
        needsOperator: "RESTART",
        needsOperatorSince: "2026-10-05T00:00:00.000Z",
      },
    ];
    const user = userEvent.setup();
    const view = render(<DeploymentOperatorNotice lang="en-US" />);
    // The slug is escaped like every node-supplied text.
    expect(
      screen.getByText("dashboard:deploymentOperator.noticeRestart:inst-\\u{202e}qwen"),
    ).toBeTruthy();
    expect(screen.getByText("dashboard:deploymentOperator.open")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "dashboard:notices.dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
    needs.items = [
      ...needs.items,
      {
        id: "i2",
        endpointSlug: "inst-b",
        needsOperator: "STEP",
        needsOperatorSince: "2026-10-05T00:01:00.000Z",
      },
    ];
    view.rerender(<DeploymentOperatorNotice lang="en-US" />);
    expect(screen.getByText("dashboard:deploymentOperator.noticeStep:inst-b")).toBeTruthy();
  });

  it("caps the badge at 9+", () => {
    render(<DeploymentNeedsBadge count={12} />);
    expect(screen.getByText("9+")).toBeTruthy();
    expect(screen.getByText("dashboard:deploymentOperator.badge")).toBeTruthy();
  });
});
