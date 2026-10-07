// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && "count" in options ? `${key}:${String(options.count)}` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <a href="/node" className={className}>
      {children}
    </a>
  ),
}));

import { NodeCard } from "./node-card";
import type { NodeSummary } from "./node-types";

afterEach(cleanup);

function node(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "node-1",
    slug: "box",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: null,
    version: "0.4.0",
    rejectedProtocolVersion: null,
    trust: {
      reported: "FULL",
      effective: "FULL",
      lowerPending: false,
      frozen: false,
      changedAt: null,
    },
    labels: ["gpu"],
    hardwareKind: "discrete",
    liveFreeMemoryGb: 12.5,
    runningInstances: 1,
    alwaysOnRuntimes: 0,
    needsYou: 0,
    hold: null,
    removeAfterOfflineMs: null,
    hostname: null,
    fabrics: [],
    gpus: [],
    secretNames: [],
    ...overrides,
  };
}

describe("NodeCard", () => {
  it("shows status and trust as text, never colour alone", () => {
    render(<NodeCard node={node()} lang="en-US" />);
    expect(screen.getByText("dashboard:nodes.status.online")).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.trust.full")).toBeTruthy();
    expect(screen.getByText("12.5 GB")).toBeTruthy();
    expect(screen.getByText("gpu")).toBeTruthy();
  });

  it("flags a pending lower, a hold, a temporary node and what needs you", () => {
    render(
      <NodeCard
        node={node({
          trust: {
            reported: "FULL",
            effective: "RELAY",
            lowerPending: true,
            frozen: true,
            changedAt: null,
          },
          hold: { at: "2026-10-06T10:00:00.000Z", note: null, profileId: null },
          removeAfterOfflineMs: 3_600_000,
          needsYou: 2,
        })}
        lang="en-US"
      />,
    );
    expect(screen.getByText("dashboard:nodes.trust.lowering")).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.hold.badge")).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.temporary.badge")).toBeTruthy();
    expect(screen.getByText("dashboard:nodes.card.needsYou:2")).toBeTruthy();
  });
});
