import { describe, expect, it } from "vitest";
import {
  cliDeviceLoginScope,
  cliSlugFromDeviceLoginScope,
  DEVICE_LOGIN_REFUSAL_REASONS,
  deviceLoginRefusalReasonOf,
} from "./cli-device-login";

describe("CLI device login scope", () => {
  it("round-trips a valid slug", () => {
    expect(cliDeviceLoginScope("desk-01")).toBe("cli-slug:desk-01");
    expect(cliSlugFromDeviceLoginScope(cliDeviceLoginScope("desk-01"))).toBe("desk-01");
  });

  it.each([
    undefined,
    null,
    "",
    "desk-01",
    "cli-slug:",
    "cli-slug:Desk-01",
    "cli-slug:desk.01",
    "cli-slug:api",
    "cli-slug:desk-01 extra",
    " cli-slug:desk-01",
    "other cli-slug:desk-01",
  ])("rejects %j", (scope) => {
    expect(cliSlugFromDeviceLoginScope(scope)).toBeNull();
  });
});

describe("deviceLoginRefusalReasonOf", () => {
  it.each(DEVICE_LOGIN_REFUSAL_REASONS)("reads %s from data.reason", (reason) => {
    expect(deviceLoginRefusalReasonOf({ code: "CONFLICT", data: { reason } })).toBe(reason);
  });

  it.each([
    null,
    undefined,
    "already_used",
    {},
    { data: null },
    { data: "already_used" },
    { data: { reason: "retained_history" } },
    { data: { reason: 3 } },
    { message: "already_used" },
  ])("is null for %j", (error) => {
    expect(deviceLoginRefusalReasonOf(error)).toBeNull();
  });
});
