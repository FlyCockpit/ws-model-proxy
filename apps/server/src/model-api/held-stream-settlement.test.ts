import { describe, expect, it } from "vitest";
import {
  deriveHeldStreamSettlement,
  type HeldStreamObservation,
} from "./held-stream-settlement.js";
import type { ProtocolSurface } from "./protocols/index.js";

const base: HeldStreamObservation = {
  stream: true,
  httpOk: true,
  streamComplete: true,
  responseComplete: true,
  protocolTerminal: true,
  protocolFailed: false,
  accountingIncomplete: false,
  nonstreamOverflow: false,
  nonstreamEnvelope: undefined,
  surface: "openai-chat",
  clientCancelled: false,
  requestAborted: false,
  capacityLeaseLost: false,
};

/** The pre-refactor inline formulas, kept verbatim as the oracle the derivation must match. */
function legacy(input: HeldStreamObservation) {
  const {
    stream,
    httpOk,
    streamComplete,
    responseComplete,
    protocolTerminal,
    protocolFailed,
    accountingIncomplete,
    nonstreamOverflow,
    nonstreamEnvelope,
    surface,
  } = input;
  const cancelledAtSettlement = input.clientCancelled;
  const settleFacts = input.requestAborted
    ? input.capacityLeaseLost
      ? ({
          reason: "CAPACITY_LEASE_LOST",
          terminalState: "FAILED",
          budgetReason: "FAILED",
        } as const)
      : ({ reason: "CANCELLED", terminalState: "CANCELLED", budgetReason: "CANCELLED" } as const)
    : null;
  const settleCancelled = cancelledAtSettlement && !input.capacityLeaseLost;
  const transportComplete = streamComplete && (responseComplete || protocolTerminal);
  const streamTerminal = !stream || protocolTerminal;
  const providerFailed =
    protocolFailed ||
    (!stream &&
      (nonstreamEnvelope?.error != null ||
        (surface === "anthropic-messages" && nonstreamEnvelope?.type === "error") ||
        (surface === "openai-responses" &&
          ["failed", "cancelled", "incomplete"].includes(
            typeof nonstreamEnvelope?.status === "string" ? nonstreamEnvelope.status : "",
          ))));
  const ok =
    transportComplete &&
    httpOk &&
    streamTerminal &&
    (stream || nonstreamEnvelope !== undefined) &&
    !providerFailed &&
    !cancelledAtSettlement;
  const observationComplete =
    transportComplete &&
    !accountingIncomplete &&
    (stream
      ? protocolTerminal && !protocolFailed
      : nonstreamEnvelope !== undefined && !nonstreamOverflow);
  return {
    ok,
    transportComplete,
    observationComplete,
    cancelled: settleCancelled,
    budgetReason: settleCancelled
      ? "CANCELLED"
      : (settleFacts?.budgetReason ?? (ok ? "COMPLETED" : "FAILED")),
    terminalState: settleCancelled
      ? "CANCELLED"
      : settleFacts
        ? settleFacts.terminalState
        : ok
          ? "COMPLETED"
          : "FAILED",
    eventReason: settleCancelled
      ? "CANCELLED"
      : settleFacts
        ? settleFacts.reason
        : ok
          ? "COMPLETED"
          : "FAILED",
  };
}

describe("held provider stream settlement", () => {
  it("matches the previous inline outcome formulas for every combination", () => {
    const flags = [
      "stream",
      "httpOk",
      "streamComplete",
      "responseComplete",
      "protocolTerminal",
      "protocolFailed",
      "accountingIncomplete",
      "nonstreamOverflow",
      "clientCancelled",
      "requestAborted",
      "capacityLeaseLost",
    ] as const;
    const envelopes: (Record<string, unknown> | undefined)[] = [
      undefined,
      { id: "ok" },
      { error: { message: "x" } },
      { type: "error" },
      { status: "incomplete" },
      { status: "completed" },
    ];
    const surfaces: ProtocolSurface[] = ["openai-chat", "anthropic-messages", "openai-responses"];
    let checked = 0;
    for (let mask = 0; mask < 1 << flags.length; mask++) {
      const observation = { ...base };
      flags.forEach((flag, bit) => {
        observation[flag] = (mask & (1 << bit)) !== 0;
      });
      for (const nonstreamEnvelope of envelopes) {
        for (const surface of surfaces) {
          const input = { ...observation, nonstreamEnvelope, surface };
          expect(deriveHeldStreamSettlement(input)).toEqual(legacy(input));
          checked++;
        }
      }
    }
    expect(checked).toBe(2048 * 18);
  });

  it("completes a stream whose terminal record and transport both completed", () => {
    expect(deriveHeldStreamSettlement(base)).toMatchObject({
      ok: true,
      observationComplete: true,
      terminalState: "COMPLETED",
    });
  });

  it("settles a bounded post-terminal drain as ok but keeps the observation incomplete", () => {
    expect(
      deriveHeldStreamSettlement({ ...base, responseComplete: false, accountingIncomplete: true }),
    ).toMatchObject({ ok: true, transportComplete: true, observationComplete: false });
  });

  it("fails a stream that ended without a protocol terminal", () => {
    expect(deriveHeldStreamSettlement({ ...base, protocolTerminal: false })).toMatchObject({
      ok: false,
      observationComplete: false,
      budgetReason: "FAILED",
    });
  });

  it("fails a failure terminal record", () => {
    expect(deriveHeldStreamSettlement({ ...base, protocolFailed: true })).toMatchObject({
      ok: false,
      terminalState: "FAILED",
    });
  });

  it("settles a client cancel as cancelled, but a lost lease as a server failure", () => {
    expect(
      deriveHeldStreamSettlement({ ...base, clientCancelled: true, requestAborted: true }),
    ).toMatchObject({ ok: false, cancelled: true, terminalState: "CANCELLED" });
    expect(
      deriveHeldStreamSettlement({
        ...base,
        clientCancelled: true,
        requestAborted: true,
        capacityLeaseLost: true,
      }),
    ).toMatchObject({
      ok: false,
      cancelled: false,
      budgetReason: "FAILED",
      terminalState: "FAILED",
      eventReason: "CAPACITY_LEASE_LOST",
    });
  });

  it("requires a parsed, non-failed, non-overflowing envelope for a non-stream", () => {
    const nonstream = { ...base, stream: false, protocolTerminal: false };
    expect(deriveHeldStreamSettlement(nonstream)).toMatchObject({ ok: false });
    expect(
      deriveHeldStreamSettlement({ ...nonstream, nonstreamEnvelope: { id: "r" } }),
    ).toMatchObject({ ok: true, observationComplete: true });
    expect(
      deriveHeldStreamSettlement({
        ...nonstream,
        surface: "openai-responses",
        nonstreamEnvelope: { status: "failed" },
      }),
    ).toMatchObject({ ok: false, observationComplete: true });
  });
});
