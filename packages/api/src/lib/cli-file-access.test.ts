import { describe, expect, it } from "vitest";
import { fileAccessRefusal, fileToolAccess, fileToolsSummary } from "./cli-file-access";
import { cliTokenAllows } from "./cli-token-capability";
import { lowestMcpCommandMode } from "./mcp-command-mode";

describe("file tool permission matrix", () => {
  const matrix = [];
  for (const mode of ["off", "supervised", "unsupervised"] as const)
    for (const server of [false, true])
      for (const live of [false, true])
        for (const roots of [false, true])
          for (const opClass of ["read", "write"] as const) {
            const expected =
              mode === "unsupervised" || (opClass === "read" && server && live && roots)
                ? "headless"
                : mode === "supervised"
                  ? "supervised"
                  : "off";
            matrix.push({ mode, server, live, roots, opClass, expected });
          }
  it.each(matrix)(
    "$mode $opClass server=$server live=$live roots=$roots -> $expected",
    ({ mode, server, live, roots, opClass, expected }) => {
      const grant = { server, live, roots };
      const access = fileToolAccess(mode, opClass, grant);
      expect(access).toBe(expected);
      expect(fileToolsSummary(mode, grant)[opClass]).toBe(expected);
      if (access !== "headless") {
        expect(fileAccessRefusal(access, "grant")).toBe(
          mode === "supervised" ? "supervised_only" : "grant_disabled",
        );
        expect(fileAccessRefusal(access, "live")).toBe(
          mode === "supervised" ? "supervised_only" : "feature_disabled",
        );
      }
    },
  );

  it("literal read-grant rows (independent of the computed table)", () => {
    const all = { server: true, live: true, roots: true };
    // [mode, grant, read, write]
    const rows = [
      ["supervised", all, "headless", "supervised"],
      ["off", all, "headless", "off"],
      ["unsupervised", undefined, "headless", "headless"],
      ["supervised", undefined, "supervised", "supervised"],
      ["off", undefined, "off", "off"],
      ["off", { ...all, server: false }, "off", "off"],
      ["off", { ...all, live: false }, "off", "off"],
      ["supervised", { ...all, roots: false }, "supervised", "supervised"],
    ] as const;
    for (const [mode, grant, read, write] of rows) {
      expect(fileToolAccess(mode, "read", grant)).toBe(read);
      expect(fileToolAccess(mode, "write", grant)).toBe(write);
    }
  });

  it("runs everything headless only on an unsupervised node", () => {
    for (const opClass of ["read", "write"] as const) {
      expect(fileToolAccess("unsupervised", opClass)).toBe("headless");
      expect(fileToolAccess("supervised", opClass)).toBe("supervised");
      expect(fileToolAccess("off", opClass)).toBe("off");
      expect(fileToolAccess(null, opClass)).toBe("off");
      expect(fileToolAccess(undefined, opClass)).toBe("off");
    }
  });

  it("summarizes read and write for the device list", () => {
    expect(fileToolsSummary("unsupervised")).toEqual({ read: "headless", write: "headless" });
    expect(fileToolsSummary("supervised")).toEqual({ read: "supervised", write: "supervised" });
    expect(fileToolsSummary("off")).toEqual({ read: "off", write: "off" });
  });

  it("uses the lowest of grant, CLI config and live hello", () => {
    const effective = lowestMcpCommandMode("unsupervised", "supervised", "unsupervised");
    expect(fileToolAccess(effective, "write")).toBe("supervised");
    expect(fileToolAccess(lowestMcpCommandMode("unsupervised", null), "read")).toBe("off");
  });

  it("maps refusals to the command codes per source", () => {
    expect(fileAccessRefusal("off", "grant")).toBe("grant_disabled");
    expect(fileAccessRefusal("off", "live")).toBe("feature_disabled");
    expect(fileAccessRefusal("supervised", "grant")).toBe("supervised_only");
    expect(fileAccessRefusal("supervised", "live")).toBe("supervised_only");
  });
});

it("missing PAT flags or scopes never authorize a CLI capability", () => {
  for (const capability of ["command", "file_read", "file_write"] as const) {
    expect(cliTokenAllows({}, capability)).toBe(false);
    expect(cliTokenAllows({ allowCliCommands: true, allowCliFileRead: true }, capability)).toBe(
      false,
    );
    expect(cliTokenAllows({ scopes: ["mcp:read", "mcp:write"] }, capability)).toBe(false);
  }
  expect(cliTokenAllows({ allowCliFileRead: true, scopes: ["mcp:read"] }, "file_read")).toBe(true);
  // The read-only flag never reaches write-class or command capabilities.
  for (const capability of ["command", "file_write"] as const) {
    expect(cliTokenAllows({ allowCliFileRead: true, scopes: ["mcp:read"] }, capability)).toBe(
      false,
    );
    expect(
      cliTokenAllows({ allowCliFileRead: true, scopes: ["mcp:read", "mcp:write"] }, capability),
    ).toBe(false);
    expect(cliTokenAllows({ allowCliCommands: true, scopes: ["mcp:read"] }, capability)).toBe(
      false,
    );
  }
  expect(cliTokenAllows({ allowCliCommands: true, scopes: ["mcp:write"] }, "file_write")).toBe(
    true,
  );
});
