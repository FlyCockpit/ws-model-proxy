import { describe, expect, it } from "vitest";

import { commandRefusals, fileReadSwitchState, readCliDeviceFeatures } from "./cli-device-features";

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
    const refusals = { headless: "cli_supervised_only", supervised: null } as const;
    expect(commandRefusals({ ...base, refusals })).toEqual(refusals);
    expect(commandRefusals(base)).toBeNull();
  });
});

describe("file read reports", () => {
  it("defaults missing opt-ins off and preserves the API file summary", () => {
    expect(readCliDeviceFeatures({})).toMatchObject({
      mcpFileRead: false,
      reportedMcpFileRead: null,
      reportedFileRoots: null,
    });
    const reported = readCliDeviceFeatures({
      mcpFileRead: true,
      reportedMcpFileRead: true,
      reportedFileRoots: true,
      fileTools: { read: "headless", write: "off" },
    });
    expect(reported).toMatchObject({
      mcpFileRead: true,
      reportedMcpFileRead: true,
      reportedFileRoots: true,
      fileTools: { read: "headless", write: "off" },
    });
  });
  it.each([false, true])(
    "grant=%s requires both CLI reports to enable and always allows narrowing",
    (granted) => {
      for (const read of [null, false, true])
        for (const roots of [null, false, true]) {
          const gate = fileReadSwitchState({
            mcpFileRead: granted,
            reportedMcpFileRead: read,
            reportedFileRoots: roots,
          });
          expect(gate.disabled).toBe(!granted && (read !== true || roots !== true));
          expect(gate.reason).toBe(
            read !== true ? "fileReadDisabled" : roots !== true ? "fileRootsMissing" : null,
          );
        }
    },
  );
});
