import { describe, expect, it } from "vitest";
import {
  allowsHeadlessCommands,
  allowsSupervisedCommands,
  isMcpCommandMode,
  lowestMcpCommandMode,
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
});
