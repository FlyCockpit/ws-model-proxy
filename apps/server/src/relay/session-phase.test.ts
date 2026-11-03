import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeHello,
  advanceLifecycle,
  awaitingHello,
  beginRegistration,
  closePhase,
  installRegistered,
  liveNode,
  type PhaseHolder,
  preRegistration,
  type RegisteredNode,
  readyNode,
  registeredNode,
} from "./session-phase.js";

function node(): RegisteredNode {
  return {
    nodeId: "node-1",
    slug: "box",
    connectionGeneration: 3,
    protocolVersion: "3.0",
    nodeVersion: "0.4.3",
    features: {} as RegisteredNode["features"],
    terminalPublicKey: "key",
    terminalIdentity: null,
    routingEvaluation: {} as RegisteredNode["routingEvaluation"],
  };
}

describe("node session phases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const holder = (): PhaseHolder & { fired: () => boolean } => {
    let fired = false;
    const deadline = setTimeout(() => {
      fired = true;
    }, 1_000);
    return { phase: awaitingHello("nonce-1", deadline), fired: () => fired };
  };

  it("walks awaiting_hello -> registering -> registered -> ready -> closed", () => {
    vi.useFakeTimers();
    const session = holder();
    expect(preRegistration(session.phase)).toBe(true);
    expect(registeredNode(session.phase)).toBeNull();

    expect(beginRegistration(session)).toBe("nonce-1");
    expect(session.phase.kind).toBe("registering");
    expect(preRegistration(session.phase)).toBe(true);
    // The nonce is one-shot.
    expect(beginRegistration(session)).toBeNull();
    expect(session.phase.kind).toBe("registering");

    const installed = node();
    expect(installRegistered(session, installed)).toBe(true);
    expect(session.phase.kind).toBe("registered");
    // The registration deadline ended with the install.
    vi.advanceTimersByTime(2_000);
    expect(session.fired()).toBe(false);
    expect(liveNode(session.phase)).toBe(installed);
    expect(readyNode(session.phase)).toBeNull();

    expect(acknowledgeHello(session)).toBe(true);
    expect(readyNode(session.phase)).toBe(installed);
    expect(acknowledgeHello(session)).toBe(false);

    expect(closePhase(session)).toEqual({ closed: true, node: installed });
    expect(liveNode(session.phase)).toBeNull();
    expect(readyNode(session.phase)).toBeNull();
    // Work still in flight can name the node it was for.
    expect(registeredNode(session.phase)).toBe(installed);
    // Idempotent: per-node cleanup runs once.
    expect(closePhase(session)).toEqual({ closed: false, node: null });
  });

  it("refuses every move the diagram does not have", () => {
    vi.useFakeTimers();
    const session = holder();
    expect(installRegistered(session, node())).toBe(false);
    expect(acknowledgeHello(session)).toBe(false);
    expect(session.phase.kind).toBe("awaiting_hello");
    beginRegistration(session);
    expect(acknowledgeHello(session)).toBe(false);
    installRegistered(session, node());
    expect(installRegistered(session, node())).toBe(false);
    expect(beginRegistration(session)).toBeNull();
    closePhase(session);
    expect(beginRegistration(session)).toBeNull();
    expect(installRegistered(session, node())).toBe(false);
    expect(acknowledgeHello(session)).toBe(false);
    expect(session.phase.kind).toBe("closed");
  });

  it.each(["awaiting_hello", "registering"] as const)(
    "closing in %s clears the registration deadline and keeps no node",
    (kind) => {
      vi.useFakeTimers();
      const session = holder();
      if (kind === "registering") beginRegistration(session);
      expect(closePhase(session)).toEqual({ closed: true, node: null });
      expect(registeredNode(session.phase)).toBeNull();
      vi.advanceTimersByTime(2_000);
      expect(session.fired()).toBe(false);
    },
  );
});

describe("manager lifecycle", () => {
  it("only moves forward", () => {
    expect(advanceLifecycle("running", "draining")).toBe("draining");
    expect(advanceLifecycle("draining", "disposed")).toBe("disposed");
    expect(advanceLifecycle("running", "disposed")).toBe("disposed");
    expect(advanceLifecycle("disposed", "draining")).toBe("disposed");
    expect(advanceLifecycle("draining", "running")).toBe("draining");
    expect(advanceLifecycle("draining", "draining")).toBe("draining");
  });
});
