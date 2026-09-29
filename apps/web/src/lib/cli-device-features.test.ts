import { describe, expect, it } from "vitest";

import { commandRefusals, readCliDeviceFeatures } from "./cli-device-features";

describe("command refusals", () => {
  it("treats a device with no reported commands as refused by the grant for both kinds", () => {
    const features = readCliDeviceFeatures({});
    expect(features.features.commands.effectiveMode).toBe("off");
    expect(features.features.commands.available).toBe(false);
    expect(commandRefusals(features.features.commands)).toEqual({
      headless: "grant_disabled",
      supervised: "grant_disabled",
    });
  });

  it("passes the API's refusals through, and none when the API omits them", () => {
    const base = {
      mode: "supervised",
      deviceMode: "supervised",
      supported: true,
      live: true,
      effectiveMode: "supervised",
      available: true,
    } as const;
    const refusals = { headless: "supervised_only", supervised: null } as const;
    expect(commandRefusals({ ...base, refusals })).toEqual(refusals);
    expect(commandRefusals(base)).toBeNull();
  });
});
