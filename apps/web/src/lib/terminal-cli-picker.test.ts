import { describe, expect, it } from "vitest";

import type { TerminalFeature } from "@/lib/cli-device-features";
import { cliPickerOption, filterCliPickerOptions } from "@/lib/terminal-cli-picker";

const usable: TerminalFeature = {
  granted: true,
  deviceAllows: true,
  supported: true,
  live: true,
  available: true,
};

function option(overrides: Partial<Parameters<typeof cliPickerOption>[0]> = {}) {
  return cliPickerOption({
    id: "cli-1",
    displayName: "Work laptop",
    slug: "desk",
    reportedHostname: "desk-01.local",
    terminal: usable,
    trust: "trusted",
    ...overrides,
  });
}

describe("cliPickerOption", () => {
  it("is selectable when the terminal is usable and the identity is trusted", () => {
    expect(option()).toEqual({
      id: "cli-1",
      name: "Work laptop",
      slug: "desk",
      reportedHostname: "desk-01.local",
      blockKey: null,
      blockIsIdentity: false,
    });
  });

  it("falls back to the slug, then the id, for the name", () => {
    expect(option({ displayName: null }).name).toBe("desk");
    expect(option({ displayName: null, slug: null }).name).toBe("cli-1");
  });

  it("blocks on a changed or invalid identity", () => {
    expect(option({ trust: "changed" })).toMatchObject({
      blockKey: "dashboard:terminals.rejection.identity_changed",
      blockIsIdentity: true,
    });
    expect(option({ trust: "invalid" })).toMatchObject({
      blockKey: "dashboard:terminals.rejection.identity_invalid",
      blockIsIdentity: true,
    });
  });

  it("prefers a feature block over an identity block", () => {
    expect(option({ terminal: { ...usable, live: false }, trust: "changed" })).toMatchObject({
      blockKey: "dashboard:terminals.reasons.offline",
      blockIsIdentity: false,
    });
    expect(option({ terminal: { ...usable, granted: false } })).toMatchObject({
      blockKey: "dashboard:terminals.reasons.notGranted",
      blockIsIdentity: false,
    });
  });
});

describe("filterCliPickerOptions", () => {
  const options = [
    option(),
    option({ id: "cli-2", displayName: "tower.lan", slug: "tower", reportedHostname: "tower.lan" }),
  ];

  it("returns everything for a blank query", () => {
    expect(filterCliPickerOptions(options, "  ")).toEqual(options);
  });

  it("matches the display name, reported hostname, and slug", () => {
    expect(filterCliPickerOptions(options, "WORK").map((entry) => entry.id)).toEqual(["cli-1"]);
    expect(filterCliPickerOptions(options, "01.local").map((entry) => entry.id)).toEqual(["cli-1"]);
    expect(filterCliPickerOptions(options, "tower").map((entry) => entry.id)).toEqual(["cli-2"]);
    expect(filterCliPickerOptions(options, "nothing")).toEqual([]);
  });
});
