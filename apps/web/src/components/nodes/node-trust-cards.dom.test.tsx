// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${JSON.stringify(options)})` : key,
    i18n: { language: "en-US" },
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/x">{children}</a>,
}));
vi.mock("@/components/time-ago", () => ({
  TimeAgo: ({ value }: { value: string }) => <time>{value}</time>,
}));
vi.mock("@/utils/orpc", () => {
  const mutation = { mutationOptions: (options?: object) => ({ ...options, mutationFn: vi.fn() }) };
  const query = {
    queryOptions: () => ({ queryKey: ["x"], queryFn: async () => null, enabled: false }),
  };
  return {
    orpc: {
      nodes: {
        key: () => ["nodes"],
        update: mutation,
        lowerTrust: mutation,
        lowerTrustPreview: query,
      },
    },
  };
});

import { TrustCard } from "./node-control-cards";
import { MetricCommandsCard } from "./node-definition-cards";
import type { NodeDetail } from "./node-types";

afterEach(cleanup);

type Trust = NodeDetail["trust"];
const RELAY: Trust = {
  reported: "RELAY",
  effective: "RELAY",
  lowerPending: false,
  frozen: true,
  changedAt: "2026-10-01T10:00:00.000Z",
  changedBy: null,
};

/** Only the fields these cards read; the rest of a node detail is irrelevant here. */
function node(trust: Trust, metricCommands: NodeDetail["metricCommands"] = []) {
  const partial: Pick<
    NodeDetail,
    "id" | "slug" | "trust" | "metricCommands" | "metricCommandsInSync"
  > = { id: "node-1", slug: "spark-1", trust, metricCommands, metricCommandsInSync: true };
  return partial as NodeDetail;
}

function wrap(children: ReactNode) {
  const client = new QueryClient();
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

describe("TrustCard", () => {
  it("names the node in the raise hint", () => {
    wrap(<TrustCard node={node(RELAY)} />);
    expect(
      screen.getByText('dashboard:nodes.trustCard.raiseHint({"slug":"spark-1"})'),
    ).toBeTruthy();
    expect(screen.getByText("wsmp trust full")).toBeTruthy();
  });

  it("says who lowered it", () => {
    wrap(
      <TrustCard
        node={node({
          ...RELAY,
          changedBy: { actor: "USER", userId: "u-1", agentTokenId: null, label: "Ada" },
        })}
      />,
    );
    expect(
      screen.getByText(/dashboard:nodes\.trustCard\.changedBy\(\{"name":"Ada"\}\)/),
    ).toBeTruthy();
  });

  it("says the node changed it when no person did", () => {
    wrap(<TrustCard node={node(RELAY)} />);
    expect(screen.getByText(/dashboard:nodes\.trustCard\.changedOnNode/)).toBeTruthy();
  });
});

describe("MetricCommandsCard when frozen", () => {
  it("shows each command's body read-only", () => {
    wrap(
      <MetricCommandsCard
        node={node(RELAY, [
          {
            name: "gpu_temp",
            command: "nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader",
            intervalSecs: 30,
            timeoutSecs: 5,
            format: "lines",
          },
        ])}
      />,
    );
    const body = screen.getByLabelText(
      'dashboard:nodes.definition.metricCommandBody({"name":"gpu_temp"})',
    );
    expect(body.tagName).toBe("PRE");
    expect(body.textContent).toContain("nvidia-smi --query-gpu=temperature.gpu");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "common:actions.save" })).toBeNull();
  });

  it("says when there are none", () => {
    wrap(<MetricCommandsCard node={node(RELAY)} />);
    expect(screen.getByText("dashboard:nodes.definition.metricCommandsNone")).toBeTruthy();
  });
});
