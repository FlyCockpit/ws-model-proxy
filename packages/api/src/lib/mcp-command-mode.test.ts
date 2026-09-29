import { describe, expect, it } from "vitest";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  isMcpCommandMode,
  lowestMcpCommandMode,
  mcpCommandLimit,
  mcpCommandModeAtLeast,
  mcpCommandModeFromDb,
  mcpCommandModeToDb,
} from "./mcp-command-mode";

describe("MCP command mode", () => {
  it("round-trips the database enum", () => {
    for (const mode of ["off", "supervised", "unsupervised"] as const) {
      expect(mcpCommandModeFromDb(mcpCommandModeToDb(mode))).toBe(mode);
    }
    expect(mcpCommandModeFromDb(null)).toBeNull();
  });

  it("takes the lowest mode and treats a missing one as off", () => {
    expect(lowestMcpCommandMode("unsupervised", "supervised")).toBe("supervised");
    expect(lowestMcpCommandMode("supervised", "unsupervised")).toBe("supervised");
    expect(lowestMcpCommandMode("unsupervised", null)).toBe("off");
    expect(lowestMcpCommandMode("unsupervised", "unsupervised")).toBe("unsupervised");
  });

  it("lets unsupervised also permit supervised, and only unsupervised run headless", () => {
    expect(allowsSupervisedCommands("supervised")).toBe(true);
    expect(allowsSupervisedCommands("unsupervised")).toBe(true);
    expect(allowsSupervisedCommands("off")).toBe(false);
    expect(allowsSupervisedCommands(undefined)).toBe(false);
    expect(allowsHeadlessCommands("unsupervised")).toBe(true);
    expect(allowsHeadlessCommands("supervised")).toBe(false);
    expect(mcpCommandModeAtLeast("supervised", "unsupervised")).toBe(false);
    expect(isMcpCommandMode("always")).toBe(false);
  });

  // grant x cli mode (live) -> the switch that limits, as the relay would refuse it.
  it.each([
    ["off", "off", "grant"],
    ["off", "supervised", "grant"],
    ["off", "unsupervised", "grant"],
    ["supervised", "off", "cliConfig"],
    ["supervised", "supervised", "both"],
    ["supervised", "unsupervised", "grant"],
    ["unsupervised", "off", "cliConfig"],
    ["unsupervised", "supervised", "cliConfig"],
    ["unsupervised", "unsupervised", null],
  ] as const)(
    "names the limiting switch: grant %s, CLI config %s -> %s",
    (grant, cliMode, want) => {
      expect(mcpCommandLimit({ grant, live: true, cliMode })).toBe(want);
    },
  );

  it("treats a live CLI with no reported mode as off", () => {
    expect(mcpCommandLimit({ grant: "supervised", live: true, cliMode: null })).toBe("cliConfig");
    expect(mcpCommandLimit({ grant: "unsupervised", live: true, cliMode: undefined })).toBe(
      "cliConfig",
    );
  });

  it("names the connection when the grant allows commands but the CLI is not live", () => {
    expect(mcpCommandLimit({ grant: "supervised", live: false, cliMode: "unsupervised" })).toBe(
      "offline",
    );
    expect(mcpCommandLimit({ grant: "unsupervised", live: false, cliMode: null })).toBe("offline");
    // An off grant is refused before the relay looks at the connection.
    expect(mcpCommandLimit({ grant: "off", live: false, cliMode: null })).toBe("grant");
  });

  it("agrees with lowestMcpCommandMode: a limit exists exactly when effective < unsupervised", () => {
    for (const grant of ["off", "supervised", "unsupervised"] as const) {
      for (const cliMode of ["off", "supervised", "unsupervised"] as const) {
        for (const live of [true, false]) {
          const effective = lowestMcpCommandMode(grant, live ? cliMode : "off");
          const limit = mcpCommandLimit({ grant, live, cliMode });
          expect(limit === null).toBe(effective === "unsupervised");
        }
      }
    }
  });
});
