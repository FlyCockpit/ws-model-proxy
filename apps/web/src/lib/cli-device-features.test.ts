import { describe, expect, it } from "vitest";

import { commandLimit, readCliDeviceFeatures } from "./cli-device-features";

describe("command limit", () => {
  it("treats a device with no reported commands as limited by the grant", () => {
    const features = readCliDeviceFeatures({});
    expect(features.features.commands.effectiveMode).toBe("off");
    expect(commandLimit(features.features.commands)).toBe("grant");
  });

  it("passes the API's limit through, and none when the API omits it", () => {
    const base = {
      mode: "supervised",
      deviceMode: "supervised",
      supported: true,
      live: true,
      effectiveMode: "supervised",
      available: true,
    } as const;
    expect(commandLimit({ ...base, limitedBy: "both" })).toBe("both");
    expect(commandLimit({ ...base, limitedBy: null })).toBeNull();
    expect(commandLimit(base)).toBeNull();
  });
});
