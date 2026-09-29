import { describe, expect, it } from "vitest";
import {
  CapacityLeaseLostError,
  capacityLeaseLostSignal,
  precommitLeaseLost,
  servedLocalTerminal,
} from "./lease-loss.js";

function abortedSignal(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe("precommitLeaseLost (F2-CAP-3 design table)", () => {
  const lost = () => new CapacityLeaseLostError("ownership_lost");
  const transport = () => new Error("socket hang up");
  const live = () => new AbortController().signal;

  it.each([
    ["typed loss, lease signal lost", lost(), abortedSignal(lost()), live(), true],
    ["typed loss even when the lease signal is not aborted", lost(), live(), live(), true],
    [
      "transport error caused by a lost lease signal",
      transport(),
      abortedSignal(lost()),
      live(),
      true,
    ],
    ["unrelated error, live lease", transport(), live(), live(), false],
    [
      "unrelated error, lease released by cleanup (non-loss reason)",
      transport(),
      abortedSignal(new Error("released")),
      live(),
      false,
    ],
    [
      "runtime shutdown keeps its own reason",
      transport(),
      abortedSignal(new Error("Capacity runtime closed.")),
      live(),
      false,
    ],
    ["no lease signal at all", transport(), undefined, live(), false],
    [
      "client abort outranks a typed loss",
      lost(),
      abortedSignal(lost()),
      abortedSignal(new Error("client")),
      false,
    ],
    [
      "client abort with a lost lease signal",
      transport(),
      abortedSignal(lost()),
      abortedSignal(new Error("client")),
      false,
    ],
  ] as const)("%s", (_label, error, leaseSignal, clientSignal, expected) => {
    expect(precommitLeaseLost(error, leaseSignal, clientSignal)).toBe(expected);
  });

  it("capacityLeaseLostSignal only accepts an aborted signal carrying the typed loss", () => {
    expect(capacityLeaseLostSignal(abortedSignal(lost()))).toBe(true);
    expect(capacityLeaseLostSignal(abortedSignal(new Error("x")))).toBe(false);
    expect(capacityLeaseLostSignal(new AbortController().signal)).toBe(false);
    expect(capacityLeaseLostSignal(null)).toBe(false);
  });
});

describe("servedLocalTerminal (F2-CAP-3 design table)", () => {
  const base = { httpStatusCode: 200, responseBytes: 5 };

  it.each([
    ["completed upstream attempt", { ok: true, failure: null }, true, "capacity_lease_lost"],
    ["failure without a cause", { ok: false, failure: null }, true, "capacity_lease_lost"],
    ["generic unknown failure", { ok: false, failure: "unknown" }, true, "capacity_lease_lost"],
    [
      "a real upstream failure keeps its own class",
      { ok: false, failure: "upstream_5xx" },
      true,
      "upstream_5xx",
    ],
    ["a cancellation keeps its class", { ok: false, failure: "cancelled" }, true, "cancelled"],
    ["no lease loss: identity (ok)", { ok: true, failure: null }, false, null],
    ["no lease loss: identity (failure)", { ok: false, failure: "unknown" }, false, "unknown"],
  ] as const)("%s", (_label, terminal, leaseLost, expectedFailure) => {
    const served = servedLocalTerminal({ ...base, ...terminal }, leaseLost);
    expect(served.failure).toBe(expectedFailure);
    expect(served.responseBytes).toBe(5);
    if (expectedFailure === "capacity_lease_lost") expect(served.ok).toBe(false);
    if (!leaseLost) expect(served).toEqual({ ...base, ...terminal });
  });
});
