import { describe, expect, it } from "vitest";
import { cliDeviceLoginScope, cliSlugFromDeviceLoginScope } from "./cli-device-login";

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
