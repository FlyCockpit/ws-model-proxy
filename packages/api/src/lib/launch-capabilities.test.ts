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
  jobReservations: true,
  rankIdle: true,
  selfUpdate: { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" },
};

describe("launchCapabilities", () => {
  it("reads what the node reports", () => {
    const capabilities = launchCapabilities({
      ...FEATURES,
      launch: { platform: "windows", management: ["process", "service"], shells: ["pwsh"] },
    });
    expect(capabilities?.platform).toBe("windows");
    expect([...(capabilities?.management ?? [])]).toEqual(["process", "service"]);
    expect([...(capabilities?.shells ?? [])]).toEqual(["pwsh"]);
  });

  it.each(["standard", "isolated"])(
    "keeps stored launch capabilities when legacy policy is %s",
    (agentCommands) => {
      const capabilities = launchCapabilities({
        ...FEATURES,
        agentCommands,
        launch: { platform: "linux", management: ["process"], shells: ["sh"] },
      });
      expect(capabilities?.platform).toBe("linux");
      expect([...(capabilities?.management ?? [])]).toEqual(["process"]);
      expect([...(capabilities?.shells ?? [])]).toEqual(["sh"]);
    },
  );

  it("says nothing when nothing says", () => {
    expect(launchCapabilities(null)).toBeNull();
    expect(launchCapabilities(FEATURES)).toBeNull();
    expect(launchCapabilities({ ...FEATURES, launch: { platform: "plan9" } })).toBeNull();
  });
});

describe("launchRunsOn", () => {
  const linux = launchCapabilities({
    ...FEATURES,
    launch: { platform: "linux", management: ["process", "service"], shells: ["sh"] },
  });
  const mac = launchCapabilities({
    ...FEATURES,
    launch: { platform: "macos", management: ["service"], shells: ["sh"] },
  });
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
