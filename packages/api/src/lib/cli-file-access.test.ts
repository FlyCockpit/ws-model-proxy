import { describe, expect, it } from "vitest";
import { fileAccessRefusal, fileToolAccess, fileToolsSummary } from "./cli-file-access";
import { lowestMcpCommandMode } from "./mcp-command-mode";

describe("file tool permission matrix", () => {
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
