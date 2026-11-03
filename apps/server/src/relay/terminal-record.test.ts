import { describe, expect, it } from "vitest";
import { newOperatorStep } from "./operator-step.js";
import {
  attachedViewer,
  attachedViewers,
  connViewerIds,
  holdsTerminalSlot,
  mintViewerId,
  openDeadlinePassed,
  pendingViewer,
  type TerminalPhase,
  type TerminalRecord,
  terminalConnIds,
  viewerIdForConn,
} from "./terminal-record.js";

function record(phase: TerminalPhase, operator = false): TerminalRecord {
  return {
    terminalId: "t-1",
    userId: "user-1",
    nodeId: "node-1",
    cols: 80,
    rows: 24,
    viewers: new Map(),
    writerViewerId: null,
    phase,
    createdAt: 0,
    operator: operator
      ? newOperatorStep({
          stepId: "s",
          instanceId: "i",
          rank: 0,
          phase: "start",
          intentHash: "h",
          ownerEpoch: "e",
          terminalId: "t-1",
          userId: "user-1",
          nodeId: "node-1",
        })
      : null,
  };
}

describe("terminal records", () => {
  it("a browser shell holds a limit slot from its open on, not while it awaits approval", () => {
    expect(holdsTerminalSlot(record({ kind: "pending", expiresAt: 10 }))).toBe(false);
    expect(holdsTerminalSlot(record({ kind: "opening", expiresAt: 10 }))).toBe(true);
    expect(holdsTerminalSlot(record({ kind: "open" }))).toBe(true);
    // Operator terminals have the engine's limits.
    expect(holdsTerminalSlot(record({ kind: "opening", expiresAt: null }, true))).toBe(false);
  });

  it("pending and opening expire at their deadline; open and operator terminals never", () => {
    expect(openDeadlinePassed(record({ kind: "pending", expiresAt: 10 }), 9)).toBe(false);
    expect(openDeadlinePassed(record({ kind: "pending", expiresAt: 10 }), 10)).toBe(true);
    expect(openDeadlinePassed(record({ kind: "opening", expiresAt: 10 }), 10)).toBe(true);
    expect(openDeadlinePassed(record({ kind: "opening", expiresAt: null }, true), 1e15)).toBe(
      false,
    );
    expect(openDeadlinePassed(record({ kind: "open" }), 1e15)).toBe(false);
  });

  it("keeps one viewer map, each viewer pending or attached", () => {
    const terminal = record({ kind: "open" });
    terminal.viewers.set("v-1", { state: "attached", connId: "c-1", attachedAt: 1 });
    terminal.viewers.set("v-2", { state: "pending", connId: "c-1", requestedAt: 2 });
    terminal.viewers.set("v-3", { state: "pending", connId: "c-2", requestedAt: 3 });
    expect(attachedViewer(terminal, "v-1")?.connId).toBe("c-1");
    expect(attachedViewer(terminal, "v-2")).toBeUndefined();
    expect(pendingViewer(terminal, "v-2")?.connId).toBe("c-1");
    expect(pendingViewer(terminal, "v-1")).toBeUndefined();
    expect(attachedViewers(terminal).map(([id]) => id)).toEqual(["v-1"]);
    expect(terminalConnIds(terminal)).toEqual(["c-1", "c-2"]);
    expect(connViewerIds(terminal, "c-1")).toEqual(["v-1", "v-2"]);
    expect(viewerIdForConn(terminal, "c-1", "attached")).toBe("v-1");
    expect(viewerIdForConn(terminal, "c-1", "pending")).toBe("v-2");
    expect(viewerIdForConn(terminal, "c-2", "attached")).toBeNull();
    expect(terminal.viewers.has(mintViewerId(terminal))).toBe(false);
  });
});
