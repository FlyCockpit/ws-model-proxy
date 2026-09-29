import { describe, expect, it } from "vitest";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  isMcpCommandMode,
  lowestMcpCommandMode,
  type McpCommandLive,
  type McpCommandRefusals,
  mcpCommandModeAtLeast,
  mcpCommandModeFromDb,
  mcpCommandModeToDb,
  mcpCommandRefusals,
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

  // The relay's refusal order, per tool (apps/server/src/relay/cli-commands.ts).
  // The real start functions are compared against this in
  // apps/server/src/relay/cli-commands.supervised.test.ts.
  const live = (
    mode: "off" | "supervised" | "unsupervised",
    terminalSupported = true,
  ): McpCommandLive => ({ mode, supervisedCommands: true, terminalSupported });

  it.each<
    [string, "off" | "supervised" | "unsupervised", McpCommandLive | null, McpCommandRefusals]
  >([
    [
      "off grant is refused before liveness",
      "off",
      null,
      { headless: "grant_disabled", supervised: "grant_disabled" },
    ],
    [
      "off grant, CLI unsupervised",
      "off",
      live("unsupervised"),
      { headless: "grant_disabled", supervised: "grant_disabled" },
    ],
    // The offline case Codex found: headless says supervised (the grant) before it looks at liveness.
    [
      "supervised grant, offline",
      "supervised",
      null,
      { headless: "grant_supervised_only", supervised: "offline" },
    ],
    [
      "unsupervised grant, offline",
      "unsupervised",
      null,
      { headless: "offline", supervised: "offline" },
    ],
    // The CLI-config-off case: the grant is checked first by headless.
    [
      "supervised grant, CLI off",
      "supervised",
      live("off"),
      { headless: "grant_supervised_only", supervised: "feature_disabled" },
    ],
    [
      "unsupervised grant, CLI off",
      "unsupervised",
      live("off"),
      { headless: "feature_disabled", supervised: "feature_disabled" },
    ],
    [
      "supervised grant, CLI supervised",
      "supervised",
      live("supervised"),
      { headless: "grant_supervised_only", supervised: null },
    ],
    [
      "unsupervised grant, CLI supervised",
      "unsupervised",
      live("supervised"),
      { headless: "cli_supervised_only", supervised: null },
    ],
    [
      "unsupervised grant, CLI unsupervised",
      "unsupervised",
      live("unsupervised"),
      { headless: null, supervised: null },
    ],
    // No PTY: supervised is refused even when the mode allows it; headless is not.
    [
      "supervised grant, CLI supervised, no PTY",
      "supervised",
      live("supervised", false),
      { headless: "grant_supervised_only", supervised: "unsupported" },
    ],
    [
      "unsupervised, no PTY",
      "unsupervised",
      live("unsupervised", false),
      { headless: null, supervised: "unsupported" },
    ],
  ])("%s", (_name, grant, liveState, want) => {
    expect(mcpCommandRefusals({ grant, live: liveState })).toEqual(want);
  });

  it("a CLI that does not implement supervised terminals is offline for supervised only", () => {
    expect(
      mcpCommandRefusals({
        grant: "unsupervised",
        live: { mode: "unsupervised", supervisedCommands: false, terminalSupported: true },
      }),
    ).toEqual({ headless: null, supervised: "offline" });
  });
});
