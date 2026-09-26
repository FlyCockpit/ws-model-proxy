import { describe, expect, it } from "vitest";
import {
  CLI_DEVICE_HOSTNAME_MAX_LENGTH,
  CLI_DEVICE_NAME_MAX_LENGTH,
  cliDeviceDisplayName,
  cliDeviceMatchesSearch,
  cliDeviceNameIssue,
  normalizeReportedHostname,
} from "./cli-device-name";

describe("cliDeviceDisplayName", () => {
  it("prefers the user's name", () => {
    expect(
      cliDeviceDisplayName({ name: "Work laptop", reportedHostname: "desk-01", slug: "desk" }),
    ).toBe("Work laptop");
  });

  it("falls back to the reported hostname, then the slug", () => {
    expect(cliDeviceDisplayName({ name: null, reportedHostname: "desk-01", slug: "desk" })).toBe(
      "desk-01",
    );
    expect(cliDeviceDisplayName({ name: null, reportedHostname: null, slug: "desk" })).toBe("desk");
    expect(cliDeviceDisplayName({ slug: "desk" })).toBe("desk");
  });

  it("skips blank values", () => {
    expect(cliDeviceDisplayName({ name: " ", reportedHostname: "", slug: "desk" })).toBe("desk");
  });
});

describe("normalizeReportedHostname", () => {
  it("trims and strips control characters", () => {
    expect(normalizeReportedHostname("  desk\u0000-01\n")).toBe("desk-01");
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeReportedHostname(undefined)).toBeNull();
    expect(normalizeReportedHostname(null)).toBeNull();
    expect(normalizeReportedHostname(" \t\u0007 ")).toBeNull();
  });

  it("bounds long hostnames", () => {
    expect(normalizeReportedHostname("a".repeat(400))).toHaveLength(CLI_DEVICE_HOSTNAME_MAX_LENGTH);
  });
});

describe("invisible characters", () => {
  it("strips format characters from reported hostnames", () => {
    // U+202E right-to-left override, U+200B zero-width space, U+FEFF BOM.
    expect(normalizeReportedHostname("‮desk​-01﻿")).toBe("desk-01");
    expect(normalizeReportedHostname("​⁦")).toBeNull();
  });

  it("rejects control and format characters in user-set names", () => {
    expect(cliDeviceNameIssue("Work laptop")).toBeNull();
    expect(cliDeviceNameIssue("desk\u0000")).toBe("invisibleCharacters");
    expect(cliDeviceNameIssue("desk‮pot")).toBe("invisibleCharacters");
    expect(cliDeviceNameIssue("desk​pot")).toBe("invisibleCharacters");
  });

  it("bounds user-set names by characters, not UTF-16 units", () => {
    expect(cliDeviceNameIssue("")).toBe("empty");
    expect(cliDeviceNameIssue("a".repeat(CLI_DEVICE_NAME_MAX_LENGTH))).toBeNull();
    expect(cliDeviceNameIssue("a".repeat(CLI_DEVICE_NAME_MAX_LENGTH + 1))).toBe("tooLong");
    expect(cliDeviceNameIssue("😀".repeat(CLI_DEVICE_NAME_MAX_LENGTH))).toBeNull();
  });
});

describe("cliDeviceMatchesSearch", () => {
  const device = { displayName: "Work laptop", reportedHostname: "desk-01.local", slug: "desk" };

  it("matches every name a device has, case-insensitively", () => {
    expect(cliDeviceMatchesSearch(device, "WORK")).toBe(true);
    expect(cliDeviceMatchesSearch(device, "01.local")).toBe(true);
    expect(cliDeviceMatchesSearch(device, " desk ")).toBe(true);
    expect(cliDeviceMatchesSearch(device, "server")).toBe(false);
  });

  it("matches everything for a blank query and tolerates missing fields", () => {
    expect(cliDeviceMatchesSearch(device, "  ")).toBe(true);
    expect(cliDeviceMatchesSearch({ slug: "desk" }, "hostname")).toBe(false);
  });
});
