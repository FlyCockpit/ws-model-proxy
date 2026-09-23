import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

/**
 * Docs-drift gate (Phase 9 "checked coverage artifact"): the
 * committed artifact docs/mcp-tool-coverage.md must be BYTE-IDENTICAL to
 * renderMcpToolCoverageDoc() output. A manifest/exclusion change without
 * regenerating the doc fails here. Regeneration (documented in the artifact
 * header): UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter server test --
 * tool-coverage-doc
 *
 * Same import graph as tool-manifest.test.ts (manifest → appRouter → env/db
 * chains), so the same mocks apply.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    MODEL_API_GLOBAL_CAPACITY_ENABLED: true,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-coverage-doc-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

vi.mock("../relay/cli-commands.js", () => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
}));

const DOC_URL = new URL("../../../../docs/mcp-tool-coverage.md", import.meta.url);

const { renderMcpToolCoverageDoc } = await import("./tool-coverage-doc");
const { MCP_TOOL_EXCLUSIONS, MCP_TOOL_MANIFEST } = await import("./tool-manifest");

// Regeneration escape hatch: UPDATE_MCP_TOOL_COVERAGE=1 rewrites the
// committed artifact FIRST (repairing any stale bytes), then asserts the
// artifact equals the freshly rendered content — so regen on a STALE
// artifact exits 0 with the bytes restored, regen on current bytes also
// exits 0, and NORMAL runs still fail on drift in the suite below (this
// block registers no test without the flag).
if (process.env.UPDATE_MCP_TOOL_COVERAGE === "1") {
  it("UPDATE_MCP_TOOL_COVERAGE=1: rewrites the committed artifact, then verifies the fresh bytes", () => {
    const fresh = renderMcpToolCoverageDoc();
    writeFileSync(DOC_URL, fresh, "utf8");
    expect(readFileSync(DOC_URL, "utf8")).toBe(fresh);
  });
}

describe("docs/mcp-tool-coverage.md — generated + pinned artifact (Phase 9)", () => {
  it("is byte-identical to renderMcpToolCoverageDoc() output (no drift)", () => {
    const committed = readFileSync(DOC_URL, "utf8");
    expect(committed).toBe(renderMcpToolCoverageDoc());
  });

  it("contains exactly one row per manifest entry and per exclusion (sorted, deterministic)", () => {
    const doc = renderMcpToolCoverageDoc();
    for (const tool of MCP_TOOL_MANIFEST) {
      expect(doc).toContain(`\`${tool.target}\``);
      expect(doc).toContain(`\`${tool.name}\``);
    }
    for (const exclusion of MCP_TOOL_EXCLUSIONS) {
      expect(doc).toContain(`\`${exclusion.target}\``);
      expect(doc).toContain(exclusion.reason);
    }
    // Deterministic: two renders are identical (no ambient state).
    expect(renderMcpToolCoverageDoc()).toBe(doc);
  });

  it("discloses every declared output projector (Phase 9 projector column)", () => {
    const doc = renderMcpToolCoverageDoc();
    const projected = MCP_TOOL_MANIFEST.filter((tool) => tool.outputProjector);
    // The class is non-empty (at least projectCredentialRows) — guards
    // against the column silently going stale if all projectors vanished.
    expect(projected.length).toBeGreaterThan(0);
    expect(doc).toContain("Output projector");
    for (const tool of projected) {
      const label = tool.outputProjector!.name || "(anonymous projector)";
      expect(doc).toContain(`\`${label}\``);
    }
    // Mutation reasoning: the label flows from the manifest into the
    // rendered bytes, so renaming projectCredentialRows (or pointing a
    // descriptor at a different projector) changes the renderer output and
    // flips the byte-drift test above until the artifact is regenerated —
    // projector changes can no longer leave the doc byte-identical.
  });
});
