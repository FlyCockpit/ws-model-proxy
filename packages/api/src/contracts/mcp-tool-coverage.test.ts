import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  apiContract,
  flattenContract,
  MCP_EXCLUDED_SESSION_PROCEDURES,
  MCP_TOOLS,
  type McpToolContract,
} from "./index";
import { advertisedInputSchema } from "./mcp-tools";

/**
 * Generator and staleness check for `docs/mcp-tool-coverage.md`: the committed file must equal
 * `renderCoverage()`. Regenerate with
 * `UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter @ws-model-proxy/api test mcp-tool-coverage`.
 */
const DOC_URL = new URL("../../../../docs/mcp-tool-coverage.md", import.meta.url);

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");
const code = (text: string) => `\`${text}\``;

function confirmLiteral(tool: McpToolContract): string {
  const schema = advertisedInputSchema(tool) as {
    properties?: Record<string, { const?: unknown }>;
    required?: string[];
  };
  const literal = schema.properties?.confirm?.const;
  if (typeof literal !== "string") return "—";
  return schema.required?.includes("confirm") ? code(literal) : `${code(literal)} (optional)`;
}

function rateLimit(tool: McpToolContract): string {
  if (!tool.rateLimit) return "— (only the `/mcp` request limit)";
  const { perMinute, key, onlyWhen } = tool.rateLimit;
  return `${perMinute}/min (${code(key)}${onlyWhen ? `, only with ${code(onlyWhen)}` : ""})`;
}

function notes(tool: McpToolContract): string {
  const parts: string[] = [];
  if (tool.sensitiveInput) parts.push("secret input, never logged or echoed");
  const compact = Object.keys(tool.compactFields ?? {});
  if (compact.length) parts.push(`compact: ${compact.map(code).join(", ")}`);
  return parts.join("; ") || "—";
}

function renderCoverage(): string {
  const procedures = flattenContract(apiContract);
  const lines = [
    "# MCP tool coverage",
    "",
    "GENERATED FILE — do not edit by hand. Produced from `MCP_TOOLS` and",
    "`MCP_EXCLUDED_SESSION_PROCEDURES` in `packages/api/src/contracts/mcp-tools.ts` and the",
    "procedure access levels in `packages/api/src/contracts/`;",
    "`packages/api/src/contracts/mcp-tool-coverage.test.ts` fails when this file drifts.",
    "Regenerate with:",
    "",
    "```sh",
    "UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter @ws-model-proxy/api test mcp-tool-coverage",
    "```",
    "",
    "Every oRPC procedure appears below: called by one or more tools (`agent` access), kept off",
    "MCP with a reason (`session` access), or unreachable by agent credentials (`public`, `human`,",
    "`admin`, `human_admin`). See [MCP server](mcp.md) for scopes, errors and examples.",
    "",
    `## Tools (${MCP_TOOLS.length})`,
    "",
    "READ credentials see the READ tools; FULL credentials see all.",
    "",
    "| Tool | Token | Procedures | Confirm | Rate limit | Notes | Description |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...MCP_TOOLS.map(
      (tool) =>
        `| ${code(tool.name)} | ${tool.level} | ${tool.procedures.map(code).join(", ")} | ${confirmLiteral(tool)} | ${rateLimit(tool)} | ${notes(tool)} | ${cell(tool.description)} |`,
    ),
    "",
    "## Session procedures kept off MCP",
    "",
    "| Procedure | Reason |",
    "| --- | --- |",
    ...Object.entries(MCP_EXCLUDED_SESSION_PROCEDURES)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, reason]) => `| ${code(path)} | ${cell(reason)} |`),
    "",
    "## Procedures agents can never reach",
    "",
    "| Access | Procedures |",
    "| --- | --- |",
    ...(["public", "human", "admin", "human_admin"] as const).map((access) => {
      const paths = procedures
        .filter(([, procedure]) => procedure.access === access)
        .map(([path]) => path)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `| ${code(access)} | ${paths.map(code).join(", ") || "—"} |`;
    }),
    "",
  ];
  return lines.join("\n");
}

if (process.env.UPDATE_MCP_TOOL_COVERAGE === "1") {
  it("rewrites docs/mcp-tool-coverage.md", () => {
    writeFileSync(DOC_URL, renderCoverage(), "utf8");
  });
}

describe("docs/mcp-tool-coverage.md", () => {
  it("matches the MCP manifest (regenerate with UPDATE_MCP_TOOL_COVERAGE=1)", () => {
    expect(readFileSync(DOC_URL, "utf8")).toBe(renderCoverage());
  });

  it("lists every procedure: agent ones under their tools, the rest exactly once", () => {
    const doc = renderCoverage();
    for (const [path, procedure] of flattenContract(apiContract)) {
      const listed = doc.split(code(path)).length - 1;
      if (procedure.access === "agent") expect(listed, path).toBeGreaterThan(0);
      else expect(listed, path).toBe(1);
    }
  });
});
