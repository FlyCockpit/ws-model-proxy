import { describe, expect, it } from "vitest";

import {
  decodeSealedFrame,
  encodeSealedFrame,
  parseTerminalServerMessage,
} from "./terminal-protocol";

function frameWithMetadata(metadata: unknown, body = new Uint8Array([1, 2, 3])): ArrayBuffer {
  const meta = new TextEncoder().encode(JSON.stringify(metadata));
  const out = new Uint8Array(4 + meta.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(body, 4 + meta.byteLength);
  return out.buffer;
}

describe("parseTerminalServerMessage", () => {
  it("reads opening and attaching with the viewer id", () => {
    expect(
      parseTerminalServerMessage({ type: "opening", terminalId: "t1", viewerId: "v1" }),
    ).toEqual({ type: "opening", terminalId: "t1", viewerId: "v1", requestId: null });
    expect(parseTerminalServerMessage({ type: "opening", terminalId: "t1" })).toEqual({
      type: "opening",
      terminalId: "t1",
      viewerId: null,
      requestId: null,
    });
    // The request id of the `open` it answers.
    expect(
      parseTerminalServerMessage({ type: "opening", terminalId: "t1", requestId: "open_1" }),
    ).toMatchObject({ requestId: "open_1" });
    expect(
      parseTerminalServerMessage({ type: "attaching", terminalId: "t1", viewerId: "v2" }),
    ).toEqual({ type: "attaching", terminalId: "t1", viewerId: "v2" });
    expect(parseTerminalServerMessage({ type: "attaching", terminalId: "t1" })).toBeNull();
  });

  it("reads viewers and rejects an unknown writer label", () => {
    expect(
      parseTerminalServerMessage({ type: "viewers", terminalId: "t1", count: 3, writer: "other" }),
    ).toEqual({ type: "viewers", terminalId: "t1", count: 3, writer: "other" });
    expect(
      parseTerminalServerMessage({ type: "viewers", terminalId: "t1", count: 1, writer: "me" }),
    ).toBeNull();
    expect(
      parseTerminalServerMessage({ type: "viewers", terminalId: "t1", count: -1, writer: "none" }),
    ).toBeNull();
  });

  it("reads the detached reason", () => {
    expect(
      parseTerminalServerMessage({ type: "detached", terminalId: "t1", reason: "slow" }),
    ).toEqual({ type: "detached", terminalId: "t1", reason: "slow" });
    expect(
      parseTerminalServerMessage({ type: "detached", terminalId: "t1", reason: "self" }),
    ).toEqual({ type: "detached", terminalId: "t1", reason: "self" });
    expect(parseTerminalServerMessage({ type: "detached", terminalId: "t1" })).toEqual({
      type: "detached",
      terminalId: "t1",
      reason: null,
    });
  });

  it("reads a close confirmation with its request id", () => {
    expect(
      parseTerminalServerMessage({ type: "closed", terminalId: "t1", requestId: "close_1" }),
    ).toEqual({ type: "closed", terminalId: "t1", requestId: "close_1" });
    expect(parseTerminalServerMessage({ type: "closed" })).toBeNull();
  });

  it("reads a decline outcome and ignores unknown outcomes", () => {
    expect(
      parseTerminalServerMessage({ type: "decline", terminalId: "t1", outcome: "started" }),
    ).toEqual({ type: "decline", terminalId: "t1", outcome: "started", requestId: null });
    expect(
      parseTerminalServerMessage({
        type: "decline",
        terminalId: "t1",
        outcome: "started",
        requestId: "decline_1",
      }),
    ).toMatchObject({ requestId: "decline_1" });
    // An error names the frame it answers, with or without a terminal.
    expect(
      parseTerminalServerMessage({ type: "error", code: "rate_limited", requestId: "decline_1" }),
    ).toMatchObject({ code: "rate_limited", terminalId: null, requestId: "decline_1" });
    expect(
      parseTerminalServerMessage({ type: "decline", terminalId: "t1", outcome: "stopped" }),
    ).toBeNull();
    expect(parseTerminalServerMessage({ type: "decline", outcome: "started" })).toBeNull();
  });

  it("reads viewer fields on listed terminals and the CLI viewer capability", () => {
    const parsed = parseTerminalServerMessage({
      type: "terminals",
      clis: [
        {
          cliDeviceId: "c1",
          slug: "desk-01",
          publicKey: "pk",
          terminalViewers: true,
          identityPublicKey: "ik",
          identitySignature: "sig",
        },
        { cliDeviceId: "c2", publicKey: null },
      ],
      terminals: [
        {
          terminalId: "t1",
          cliDeviceId: "c1",
          label: "box",
          viewerAttached: true,
          viewerCount: 2,
          attachedHere: true,
          writerHere: false,
        },
        { terminalId: "t2", cliDeviceId: "c2", viewerAttached: true },
      ],
    });
    expect(parsed).toEqual({
      type: "terminals",
      clis: [
        {
          cliDeviceId: "c1",
          slug: "desk-01",
          publicKey: "pk",
          terminalViewers: true,
          identityPublicKey: "ik",
          identitySignature: "sig",
        },
        {
          cliDeviceId: "c2",
          slug: null,
          publicKey: null,
          terminalViewers: false,
          identityPublicKey: null,
          identitySignature: null,
        },
      ],
      pushed: false,
      terminals: [
        {
          terminalId: "t1",
          origin: "user",
          supervised: null,
          cliDeviceId: "c1",
          cols: 80,
          rows: 24,
          viewerCount: 2,
          attachedHere: true,
          writerHere: false,
          viewerAttached: true,
        },
        {
          terminalId: "t2",
          origin: "user",
          supervised: null,
          cliDeviceId: "c2",
          cols: 80,
          rows: 24,
          viewerCount: 1,
          attachedHere: false,
          writerHere: false,
          viewerAttached: true,
        },
      ],
    });
  });
});

describe("agent terminals", () => {
  const supervised = {
    commandId: "cmd",
    status: "awaiting_user",
    requester: "laptop agent",
    reason: "installs deps",
    command: "sudo apt install jq",
    cwd: "/home/me",
    shareOutput: true,
    createdAt: "2026-09-24T00:00:00.000Z",
    expiresAt: "2026-09-24T00:15:00.000Z",
    exitCode: null,
    signal: null,
  };

  it("reads origin, request details, and the pushed flag", () => {
    const parsed = parseTerminalServerMessage({
      type: "terminals",
      pushed: true,
      clis: [],
      terminals: [{ terminalId: "t1", cliDeviceId: "c1", origin: "agent", supervised }],
    });
    expect(parsed).toMatchObject({
      type: "terminals",
      pushed: true,
      terminals: [{ terminalId: "t1", origin: "agent", supervised }],
    });
  });

  it("keeps an agent terminal an agent terminal even with unreadable details", () => {
    const parsed = parseTerminalServerMessage({
      type: "terminals",
      clis: [],
      terminals: [
        { terminalId: "t1", cliDeviceId: "c1", origin: "agent", supervised: { status: "?" } },
        { terminalId: "t2", cliDeviceId: "c1", origin: "martian" },
      ],
    });
    expect(parsed).toMatchObject({
      pushed: false,
      terminals: [
        { terminalId: "t1", origin: "agent", supervised: null },
        { terminalId: "t2", origin: "user", supervised: null },
      ],
    });
  });
});

describe("sealed frames", () => {
  it("round-trips a browser frame without an epoch", () => {
    const body = new Uint8Array([9, 8, 7]);
    const decoded = decodeSealedFrame(encodeSealedFrame({ terminalId: "t1", seq: 4, body }));
    expect(decoded).toEqual({ terminalId: "t1", seq: 4, body });
    expect("epoch" in decoded).toBe(false);
  });

  it("keeps the epoch of a broadcast frame", () => {
    const decoded = decodeSealedFrame(
      frameWithMetadata({ type: "term.sealed", terminalId: "t1", seq: 2, epoch: 3 }),
    );
    expect(decoded.epoch).toBe(3);
    expect(decoded.seq).toBe(2);
  });

  it("rejects an out-of-range or non-integer epoch", () => {
    for (const epoch of [0, -1, 1.5, 2 ** 32, "1"]) {
      expect(() =>
        decodeSealedFrame(
          frameWithMetadata({ type: "term.sealed", terminalId: "t1", seq: 1, epoch }),
        ),
      ).toThrow();
    }
  });
});
