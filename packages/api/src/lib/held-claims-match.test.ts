import { describe, expect, it } from "vitest";
import { type HeldRankClaim, heldClaimsMatch } from "./reservations";

// A definition update's "restart running" keeps an instance's claims where they are: only when
// they are what the new version claims AND where they are satisfies its placement (ports, node
// labels, fabric). Anything else is placed by a start.

const GB16 = { kind: "unified", memoryGb: 16 } as const;

function spec(launch: Record<string, unknown> = {}) {
  return {
    api: "openai",
    engine: "vllm",
    modelType: "llm",
    models: [{ id: "qwen" }],
    launch: {
      management: "process",
      groupSize: 2,
      resources: [GB16],
      labels: [],
      commands: [{ start: "vllm serve qwen --port {{port}}", stop: "true" }],
      readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
      health: { intervalMs: 15_000, failureThreshold: 3, successThreshold: 1 },
      ...launch,
    },
  };
}

function gang(overrides: Partial<HeldRankClaim> = {}): HeldRankClaim[] {
  return [0, 1].map((rank) => ({
    rank,
    resources: GB16,
    port: 30000,
    distPort: 30001,
    Node: { labels: ["gpu"] },
    ...overrides,
  }));
}

describe("heldClaimsMatch compares where the claims are", () => {
  it("a gang in any fabric matches a version that names none", () => {
    expect(heldClaimsMatch(spec(), gang(), [], { name: "qsfp" })).toBe(true);
  });

  it("a version naming another fabric than the instance's does not match", () => {
    expect(heldClaimsMatch(spec({ fabric: "ib" }), gang(), [], { name: "qsfp" })).toBe(false);
    expect(heldClaimsMatch(spec({ fabric: "qsfp" }), gang(), [], { name: "qsfp" })).toBe(true);
  });

  it("a gang without its fabric or dist port does not match", () => {
    expect(heldClaimsMatch(spec(), gang(), [], null)).toBe(false);
    expect(heldClaimsMatch(spec(), gang({ distPort: null }), [], { name: "qsfp" })).toBe(false);
  });

  it("a fixed port or labels the held claim does not satisfy do not match", () => {
    const single = spec({ groupSize: 1 });
    const one = gang().slice(0, 1);
    expect(heldClaimsMatch(spec({ groupSize: 1, port: { fixed: 30005 } }), one, [], null)).toBe(
      false,
    );
    expect(heldClaimsMatch(spec({ groupSize: 1, port: { fixed: 30000 } }), one, [], null)).toBe(
      true,
    );
    expect(heldClaimsMatch(spec({ groupSize: 1, labels: ["nvlink"] }), one, [], null)).toBe(false);
    expect(heldClaimsMatch(single, gang({ Node: null }).slice(0, 1), [], null)).toBe(false);
  });
});
