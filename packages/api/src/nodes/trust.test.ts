import { describe, expect, it } from "vitest";
import { effectiveTrust, isFullControl, type NodeTrustViewColumns, nodeTrustView } from "./trust";

const at = new Date("2026-10-01T10:00:00.000Z");
const requested = new Date("2026-10-02T10:00:00.000Z");

function node(overrides: Partial<NodeTrustViewColumns>): NodeTrustViewColumns {
  return {
    userId: "owner-1",
    trust: "FULL",
    trustChangedAt: at,
    trustLowerRequestedAt: null,
    trustLowerRequestedBy: null,
    User: { name: "Ada" },
    ...overrides,
  };
}

const ADA = { actor: "USER", userId: "owner-1", agentTokenId: null, label: "Ada" };

describe("nodeTrustView changedBy", () => {
  it("names nobody while the node is at Full control", () => {
    expect(nodeTrustView(node({}))).toMatchObject({ effective: "FULL", changedBy: null });
  });

  it("names the person and the request time while a lowering is pending", () => {
    const view = nodeTrustView(
      node({ trustLowerRequestedAt: requested, trustLowerRequestedBy: "owner-1" }),
    );
    expect(view).toMatchObject({
      effective: "RELAY",
      lowerPending: true,
      changedAt: requested.toISOString(),
      changedBy: ADA,
    });
  });

  it("keeps the person after the node confirmed the lowering", () => {
    const view = nodeTrustView(node({ trust: "RELAY", trustLowerRequestedBy: "owner-1" }));
    expect(view).toMatchObject({
      effective: "RELAY",
      lowerPending: false,
      changedAt: at.toISOString(),
      changedBy: ADA,
    });
  });

  it("names nobody when the node set Relay only itself", () => {
    expect(nodeTrustView(node({ trust: "RELAY" })).changedBy).toBeNull();
  });

  it("never names someone other than the owner", () => {
    const view = nodeTrustView(node({ trust: "RELAY", trustLowerRequestedBy: "someone-else" }));
    expect(view.changedBy).toBeNull();
  });

  it("names nobody once the node is back at Full control", () => {
    // The relay clears the column on that change; a stale value still shows nothing.
    expect(nodeTrustView(node({ trustLowerRequestedBy: "owner-1" })).changedBy).toBeNull();
  });
});

describe("effectiveTrust", () => {
  it("is Relay only before the first hello and while a lowering is pending", () => {
    expect(effectiveTrust(node({ trust: null }))).toBe("RELAY");
    expect(effectiveTrust(node({ trustLowerRequestedAt: requested }))).toBe("RELAY");
    expect(isFullControl(node({}))).toBe(true);
  });
});
