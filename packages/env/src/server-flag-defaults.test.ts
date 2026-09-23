import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
}

const { strictBooleanFlag } = await import("./shared.js");

const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const manifestSource = readFileSync(
  new URL("../../../scripts/lib/env-manifest.ts", import.meta.url),
  "utf8",
);

function manifestDefault(key: string): string {
  const keyIndex = manifestSource.indexOf(`key: "${key}"`);
  expect(keyIndex).toBeGreaterThan(-1);
  const window = manifestSource.slice(keyIndex, keyIndex + 900);
  const match = /default: "([^"]*)"/.exec(window);
  expect(match).not.toBeNull();
  return match?.[1] ?? "";
}

describe("egress and MCP kill-switch defaults", () => {
  it("treats an omitted strictBooleanFlag(true) as true and an omitted strictBooleanFlag() as false", () => {
    expect(strictBooleanFlag(true).parse(undefined)).toBe(true);
    expect(strictBooleanFlag().parse(undefined)).toBe(false);
    expect(strictBooleanFlag(true).parse("false")).toBe(false);
    expect(strictBooleanFlag().parse("true")).toBe(true);
  });

  it("defaults egress and MCP on without opening signup or private networks", () => {
    expect(serverSource).toContain("WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: strictBooleanFlag(true)");
    expect(serverSource).toContain("WMP_MCP_ENABLED: strictBooleanFlag(true)");
    expect(serverSource).toContain("WMP_MCP_PAT_ALLOW_NO_EXPIRY: strictBooleanFlag(true)");
    expect(serverSource).toContain("SIGNUP_ENABLED: strictBooleanFlag(),");
    expect(serverSource).toContain("WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: strictBooleanFlag(),");
    expect(serverSource).not.toContain("Keep false until");
    expect(serverSource).not.toContain("Release gate");

    expect(manifestDefault("WMP_PUBLIC_PROVIDER_EGRESS_ENABLED")).toBe("true");
    expect(manifestDefault("WMP_MCP_ENABLED")).toBe("true");
    expect(manifestDefault("WMP_MCP_PAT_ALLOW_NO_EXPIRY")).toBe("true");
    expect(manifestDefault("SIGNUP_ENABLED")).toBe("false");
    expect(manifestDefault("WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS")).toBe("false");
    expect(manifestSource).not.toContain("Keep false until");
    expect(manifestSource).not.toContain("Release gate for");
  });
});
