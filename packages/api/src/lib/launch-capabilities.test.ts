import { describe, expect, it } from "vitest";
import { launchCapabilities, launchRunsOn, launchShell } from "./launch-capabilities";

const FEATURES = {
  terminals: { supported: true, max: 4, approvalRequired: false },
  operatorTerminals: false,
  files: { roots: null, asRoot: false, source: "default" },
  runtimeHosts: [],
  mediaExpand: true,
  liveStt: true,
  secrets: [],
};

describe("launchCapabilities", () => {
  it("reads what the node reports", () => {
    const capabilities = launchCapabilities(
      {
        ...FEATURES,
        launch: { platform: "windows", management: ["process", "service"], shells: ["pwsh"] },
      },
      { executionMechanism: "unsupported" },
    );
    expect(capabilities?.platform).toBe("windows");
    expect([...(capabilities?.management ?? [])]).toEqual(["process", "service"]);
    expect([...(capabilities?.shells ?? [])]).toEqual(["pwsh"]);
  });

  it("reads an older CLI's execution mechanism", () => {
    expect(launchCapabilities(FEATURES, { executionMechanism: "macos" })).toEqual({
      platform: "macos",
      management: new Set(["service"]),
      shells: new Set(["sh"]),
    });
    for (const mechanism of ["systemd+linger", "systemd-no-linger"])
      expect(launchCapabilities(null, { executionMechanism: mechanism })?.platform).toBe("linux");
  });

  it("says nothing when nothing says", () => {
    expect(launchCapabilities(null, null)).toBeNull();
    expect(launchCapabilities(FEATURES, { executionMechanism: "unsupported" })).toBeNull();
    // An unreadable report falls back to the mechanism.
    expect(
      launchCapabilities(
        { ...FEATURES, launch: { platform: "plan9" } },
        { executionMechanism: "macos" },
      )?.platform,
    ).toBe("macos");
  });
});

describe("launchRunsOn", () => {
  const linux = launchCapabilities(null, { executionMechanism: "systemd+linger" });
  const mac = launchCapabilities(null, { executionMechanism: "macos" });
  if (!linux || !mac) throw new Error("capabilities");

  it("needs the management mode", () => {
    const process = { management: "process" as const, commands: [{ start: "serve" }] };
    expect(launchRunsOn(process, linux)).toBe(true);
    expect(launchRunsOn(process, mac)).toBe(false);
    expect(launchRunsOn({ ...process, management: "service" }, mac)).toBe(true);
  });

  it("needs the shell of the text commands", () => {
    const windows = {
      platform: "windows" as const,
      management: new Set(["process", "service"] as const),
      shells: new Set(["pwsh"] as const),
    };
    const launch = { management: "process" as const, commands: [{ start: "serve" }] };
    expect(launchShell(launch)).toBe("sh");
    expect(launchRunsOn(launch, windows)).toBe(false);
    // A shape without commands or management needs nothing.
    expect(launchRunsOn({}, windows)).toBe(true);
    // The launch names its shell.
    expect(launchShell({ ...launch, shell: "pwsh" })).toBe("pwsh");
    expect(launchRunsOn({ ...launch, shell: "pwsh" }, windows)).toBe(true);
  });

  it("runs argv commands from any shell but cmd", () => {
    const argv = { management: "process" as const, commands: [{ start: ["serve", "--port"] }] };
    expect(launchShell(argv)).toBeNull();
    expect(launchRunsOn(argv, linux)).toBe(true);
    const cmdOnly = {
      platform: "windows" as const,
      management: new Set(["process"] as const),
      shells: new Set(["cmd"] as const),
    };
    expect(launchRunsOn(argv, cmdOnly)).toBe(false);
  });
});
