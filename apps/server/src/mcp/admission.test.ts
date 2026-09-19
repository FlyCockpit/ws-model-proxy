import { describe, expect, it } from "vitest";

/**
 * Admission-gate primitive tests (Part F pass 3, F8; terminal semantics
 * pass 4). The gate exists to close the SDK's pre-factory tracking gap:
 * `createMcpHandler.close()` only awaits servers the FACTORY already
 * created, so a request still reading its body has no tracked server.
 * These tests pin the PERMIT semantics the shutdown sequence relies on:
 * release-on-settlement, close() ABORTS outstanding controllers (bounded
 * close), and release means work stopped (route-level behavior is covered
 * in auth.test.ts; the real-transport lifecycle probes live there too).
 */

import { createMcpAdmissionGate } from "./admission";

describe("createMcpAdmissionGate", () => {
  it("admits while open, hands each admission its OWN controller, tracks releases", () => {
    const gate = createMcpAdmissionGate();
    expect(gate.closed).toBe(false);
    expect(gate.outstanding).toBe(0);
    const a = gate.admit();
    const b = gate.admit();
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.controller).toBeInstanceOf(AbortController);
    expect(b?.controller).not.toBe(a?.controller);
    expect(a?.controller.signal.aborted).toBe(false);
    expect(gate.outstanding).toBe(2);
    a?.release();
    expect(gate.outstanding).toBe(1);
    b?.release();
    expect(gate.outstanding).toBe(0);
  });

  it("close() resolves immediately when nothing is outstanding", async () => {
    const gate = createMcpAdmissionGate();
    await expect(gate.close()).resolves.toBeUndefined();
    expect(gate.closed).toBe(true);
  });

  it("close() rejects new admissions from the moment it is called (synchronous flag flip)", async () => {
    const gate = createMcpAdmissionGate();
    const admission = gate.admit();
    const closing = gate.close();
    expect(gate.closed).toBe(true);
    expect(gate.admit()).toBeNull();
    admission?.release();
    await closing;
  });

  it("close() ABORTS every outstanding controller (bounded close — cancellation, not just waiting)", () => {
    const gate = createMcpAdmissionGate();
    const a = gate.admit();
    const b = gate.admit();
    expect(a?.controller.signal.aborted).toBe(false);
    void gate.close();
    expect(a?.controller.signal.aborted).toBe(true);
    expect(b?.controller.signal.aborted).toBe(true);
    a?.release();
    b?.release();
  });

  it("close() waits for EVERY outstanding admission and resolves exactly when the last releases", async () => {
    const gate = createMcpAdmissionGate();
    const a = gate.admit();
    const b = gate.admit();
    // close() aborts both controllers immediately, but resolution still
    // waits for every admission's SETTLED-work release.
    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    expect(a?.controller.signal.aborted).toBe(true);
    expect(b?.controller.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still owned: one admission outstanding.
    expect(closed).toBe(false);
    a?.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Still owned: the second admission is outstanding.
    expect(closed).toBe(false);
    b?.release();
    await closing;
    expect(closed).toBe(true);
    expect(gate.outstanding).toBe(0);
  });

  it("release is idempotent — double release cannot underflow or re-resolve close()", async () => {
    const gate = createMcpAdmissionGate();
    const admission = gate.admit();
    admission?.release();
    admission?.release();
    expect(gate.outstanding).toBe(0);
    await expect(gate.close()).resolves.toBeUndefined();
  });

  it("a late admission rejected after close does not resurrect the closed state", async () => {
    const gate = createMcpAdmissionGate();
    await gate.close();
    expect(gate.admit()).toBeNull();
    expect(gate.closed).toBe(true);
    expect(gate.outstanding).toBe(0);
  });

  it("double close(): both promises resolve once outstanding admissions settle", async () => {
    const gate = createMcpAdmissionGate();
    const admission = gate.admit();
    const first = gate.close();
    const second = gate.close();
    admission?.release();
    await Promise.all([first, second]);
    expect(gate.closed).toBe(true);
  });

  it("release after close() aborts cleanly (no double-abort, no throw)", () => {
    const gate = createMcpAdmissionGate();
    const admission = gate.admit();
    const controller = admission?.controller;
    void gate.close();
    expect(() => controller?.abort()).not.toThrow();
    admission?.release();
    expect(gate.outstanding).toBe(0);
  });

  it("onClosed (pass 5) runs EXACTLY ONCE, synchronously at close() start, BEFORE controllers abort", () => {
    const calls: string[] = [];
    const gate = createMcpAdmissionGate({
      onClosed: () => calls.push("onClosed"),
    });
    const admission = gate.admit();
    admission?.controller.signal.addEventListener("abort", () => calls.push("aborted"));
    calls.push("close-start");
    void gate.close();
    // Ordering pinned: the shutdown-side fences (production: the auth
    // DB-seam fence) arm BEFORE any abort can resume a stray continuation.
    expect(calls).toEqual(["close-start", "onClosed", "aborted"]);
    admission?.release();
    // A second close does not re-arm.
    void gate.close();
    expect(calls).toEqual(["close-start", "onClosed", "aborted"]);
  });

  it("onClosed defaults to none (unit tests constructing the gate without it are unaffected)", async () => {
    const gate = createMcpAdmissionGate();
    await expect(gate.close()).resolves.toBeUndefined();
  });
});
