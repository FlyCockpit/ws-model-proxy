import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * Drift and overlay contract for the generated MCP input schemas (#117).
 * The expected schema is recomputed HERE, independently of the generator,
 * straight from each tool's real oRPC procedure input schema, so an
 * advertised schema that drifts from its procedure fails this suite.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-manifest-test",
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

const { MCP_TOOL_MANIFEST } = await import("./tool-manifest");
const { appRouter } = await import("@ws-model-proxy/api/routers/index");
const { applyInputOverlay, toInputJsonSchema, MCP_TOOL_INPUT_MAX_BYTES } = await import(
  "./input-schema"
);

type Json = Record<string, unknown>;
type Tool = (typeof MCP_TOOL_MANIFEST)[number];

/** Independent overlay table: the ONLY MCP-owned fields, by tool. */
const FORBIDDEN: Record<string, { fields: string[]; names: string }> = {
  forwarder_model_pool_create: {
    fields: ["fallbackEnabled", "fallbackForGrantees"],
    names: "forwarder_pool_fallback_update",
  },
  forwarder_model_pool_update: {
    fields: ["fallbackEnabled", "fallbackForGrantees"],
    names: "forwarder_pool_fallback_update",
  },
  provider_account_create: { fields: ["allowDataCollection"], names: "person in the dashboard" },
  provider_account_update: { fields: ["allowDataCollection"], names: "person in the dashboard" },
};
const EMPTY_ARRAY: Record<string, string[]> = { forwarder_guarded_pool_create: ["providerModels"] };
const DATE_FIELDS: Record<string, string[]> = {
  relay_requests_list: ["createdAfter", "createdBefore"],
  forwarder_cli_metadata_remove: ["staleBefore"],
  forwarder_endpoint_metadata_remove: ["staleBefore"],
  forwarder_model_metadata_remove: ["staleBefore"],
};
const RUN_CONFIRM = {
  type: "string",
  const: "RUN",
  description: 'Must be exactly "RUN" to confirm this call.',
};
const coreSchema = (properties: Json, required: string[]): Json => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  additionalProperties: {},
  required,
});
/**
 * Extracted cores have no procedure: their MCP-owned argument schemas are
 * pinned here in full (types, constraints and required fields).
 */
const CORE_SCHEMAS: Record<string, Json> = {
  forwarder_pool_member_test: coreSchema(
    { memberId: { type: "string", minLength: 1 }, confirm: RUN_CONFIRM },
    ["memberId", "confirm"],
  ),
  forwarder_chat_completion_test: coreSchema(
    {
      model: { type: "string", minLength: 1 },
      messages: { type: "array", items: {} },
      confirm: RUN_CONFIRM,
    },
    ["model", "messages", "confirm"],
  ),
  forwarder_cli_command_run: coreSchema(
    {
      cliDeviceId: { type: "string" },
      command: { type: "string" },
      cwd: { type: "string" },
      waitMs: { type: "number" },
      confirm: RUN_CONFIRM,
    },
    ["cliDeviceId", "command", "confirm"],
  ),
  forwarder_cli_supervised_command_start: coreSchema(
    {
      cliDeviceId: { type: "string" },
      command: { type: "string" },
      cwd: { type: "string" },
      reason: { type: "string" },
      shareOutput: { type: "boolean" },
      confirm: RUN_CONFIRM,
    },
    ["cliDeviceId", "command", "confirm"],
  ),
  forwarder_cli_command_result: coreSchema(
    { commandId: { type: "string" }, progress: { type: "boolean" } },
    ["commandId"],
  ),
};

function advertised(tool: Tool): Json {
  return tool.inputSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
}

function procedureInput(target: string): z.ZodType | undefined {
  let node: unknown = appRouter;
  for (const segment of target.split(".")) node = (node as Record<string, unknown>)[segment];
  return (node as { "~orpc": { inputSchema?: z.ZodType } })["~orpc"].inputSchema;
}

const procedureTools = MCP_TOOL_MANIFEST.filter((tool) => !tool.target.startsWith("core:"));
const coreTools = MCP_TOOL_MANIFEST.filter((tool) => tool.target.startsWith("core:"));

describe("advertised schema equals the procedure schema plus declared overlays", () => {
  it("covers every procedure-backed tool and every core", () => {
    expect(procedureTools.length + coreTools.length).toBe(MCP_TOOL_MANIFEST.length);
    expect(procedureTools.length).toBeGreaterThan(70);
    expect(coreTools.map((tool) => tool.name).sort()).toEqual(Object.keys(CORE_SCHEMAS).sort());
  });

  it.each(procedureTools.map((tool) => [tool.name, tool] as const))(
    "%s: the WHOLE advertised schema equals the procedure schema plus declared overlays",
    (_name, tool) => {
      const input = procedureInput(tool.target);
      // Independent of the generator: straight zod -> JSON Schema, then only
      // the overlay tables above are applied. Every root keyword (`oneOf`,
      // `additionalProperties`, `$schema`, ...) stays in the comparison.
      const base = z.toJSONSchema(input ?? z.looseObject({}), {
        io: "input",
        unrepresentable: "any",
      }) as Json;
      const { properties: baseProperties, required: baseRequiredRaw, ...root } = base;
      const json = advertised(tool);
      const forbidden = FORBIDDEN[tool.name]?.fields ?? [];
      // Overlay property shapes are written out literally here (descriptions
      // that name a replacement tool are matched by the tool name).
      const expectedProps: Record<string, unknown> = { ...(baseProperties as Json) };
      for (const key of FORBIDDEN[tool.name]?.fields ?? []) {
        expectedProps[key] = {
          not: {},
          description: expect.stringContaining(FORBIDDEN[tool.name]!.names),
        };
      }
      for (const key of EMPTY_ARRAY[tool.name] ?? []) {
        expectedProps[key] = {
          type: "array",
          maxItems: 0,
          description: expect.stringContaining("forwarder_provider_member_add"),
        };
      }
      for (const key of DATE_FIELDS[tool.name] ?? []) {
        expectedProps[key] = {
          type: "string",
          format: "date-time",
          description:
            "RFC 3339 UTC timestamp in the exact form YYYY-MM-DDTHH:MM:SS[.fff]Z (no offsets).",
        };
      }
      if (tool.confirmation !== null) {
        expectedProps.confirm = {
          type: "string",
          const: tool.confirmation,
          description: `Must be exactly "${tool.confirmation}" to confirm this call.`,
        };
      }
      const expectedRequired = [
        ...new Set([
          ...((baseRequiredRaw ?? []) as string[]).filter((key) => !forbidden.includes(key)),
          ...(tool.confirmation === null ? [] : ["confirm"]),
        ]),
      ];
      const expected: Json = {
        ...root,
        type: "object",
        properties: expectedProps,
        ...(expectedRequired.length > 0 ? { required: expectedRequired } : {}),
      };
      expect(json).toEqual(expected);
    },
  );

  it("a root-union input keeps its branches (the #117 defect must not return)", () => {
    const json = advertised(
      MCP_TOOL_MANIFEST.find((tool) => tool.name === "forwarder_model_capability_profile_set")!,
    );
    const branches = (json.oneOf ?? json.anyOf) as Json[];
    expect(branches.length).toBeGreaterThan(1);
    for (const branch of branches) {
      expect(branch.required).toEqual(expect.arrayContaining(["mode"]));
    }
    expect(branches.some((branch) => (branch.required as string[]).includes("id"))).toBe(true);
  });

  it("strict procedures advertise their closed shape", () => {
    const json = advertised(
      MCP_TOOL_MANIFEST.find((tool) => tool.name === "forwarder_pool_fallback_update")!,
    );
    expect(json.additionalProperties).toBe(false);
  });

  it("the fields agents could not discover before are now required", () => {
    const byName = new Map(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool]));
    expect(advertised(byName.get("forwarder_pool_fallback_get")!).required).toEqual(["poolId"]);
    expect(advertised(byName.get("forwarder_affinity_stats_get")!).required).toEqual(["poolId"]);
    expect(advertised(byName.get("model_api_tokens_preview")!).required).toEqual(["scopeMode"]);
  });

  it.each(coreTools.map((tool) => [tool.name, tool] as const))(
    "%s: extracted core advertises exactly its pinned argument schema",
    (name, tool) => {
      expect(advertised(tool)).toEqual(CORE_SCHEMAS[name]);
    },
  );
});

describe("MCP-owned overlays", () => {
  it("every confirmation-gated tool requires the exact literal", () => {
    const gated = MCP_TOOL_MANIFEST.filter((tool) => tool.confirmation !== null);
    expect(gated.length).toBeGreaterThan(20);
    for (const tool of gated) {
      const json = advertised(tool);
      expect((json.properties as Json).confirm).toMatchObject({
        type: "string",
        const: tool.confirmation,
      });
      expect(json.required).toContain("confirm");
    }
    for (const tool of MCP_TOOL_MANIFEST.filter((item) => item.confirmation === null)) {
      expect((advertised(tool).properties as Json).confirm).toBeUndefined();
    }
  });

  it("forbidden fields carry a description naming the tool to use, never a bare {not:{}}", () => {
    for (const [name, { fields, names }] of Object.entries(FORBIDDEN)) {
      const json = advertised(MCP_TOOL_MANIFEST.find((tool) => tool.name === name)!);
      for (const field of fields) {
        const property = (json.properties as Record<string, Json>)[field]!;
        expect(property.not).toEqual({});
        expect(property.description).toEqual(expect.stringContaining(names));
      }
      expect(json.required ?? []).not.toEqual(expect.arrayContaining(fields));
    }
    // Every `not: {}` property in the whole manifest has a description.
    for (const tool of MCP_TOOL_MANIFEST) {
      for (const property of Object.values(advertised(tool).properties as Record<string, Json>)) {
        if (property.not !== undefined) expect(property.description).toBeTypeOf("string");
      }
    }
  });

  it("date-valued procedure inputs advertise an RFC 3339 string, not an empty schema", () => {
    for (const [name, fields] of Object.entries(DATE_FIELDS)) {
      const props = advertised(MCP_TOOL_MANIFEST.find((tool) => tool.name === name)!)
        .properties as Record<string, Json>;
      for (const field of fields) {
        expect(props[field]).toMatchObject({ type: "string", format: "date-time" });
      }
    }
  });

  it("guarded create advertises providerModels as empty-only", () => {
    const props = advertised(
      MCP_TOOL_MANIFEST.find((tool) => tool.name === "forwarder_guarded_pool_create")!,
    ).properties as Record<string, Json>;
    expect(props.providerModels).toMatchObject({ type: "array", maxItems: 0 });
    expect(props.providerModels?.description).toEqual(
      expect.stringContaining("forwarder_provider_member_add"),
    );
  });

  it("unrepresentable zod input types do not throw and advertise {}", () => {
    const schema = z.object({
      when: z.date(),
      shout: z.string().transform((value) => value.toUpperCase()),
      plain: z.string(),
    });
    const base = toInputJsonSchema(schema);
    expect((base.properties as Json).when).toEqual({});
    expect((base.properties as Json).plain).toEqual({ type: "string" });
    const merged = applyInputOverlay(base, { target: "x.y", confirmation: "RUN" });
    expect((merged.properties as Json).confirm).toMatchObject({ const: "RUN" });
    expect(merged.required).toEqual(expect.arrayContaining(["when", "plain", "confirm"]));
  });

  it("a forbidden field the procedure marks required is no longer required", () => {
    const base = toInputJsonSchema(z.object({ keep: z.string(), banned: z.boolean() }));
    const merged = applyInputOverlay(base, {
      target: "x.y",
      confirmation: null,
      forbiddenInputs: { banned: "Use other_tool." },
    });
    expect(merged.required).toEqual(["keep"]);
    expect((merged.properties as Json).banned).toEqual({ not: {}, description: "Use other_tool." });
  });

  it("overlay merging does not mutate a cached base schema", () => {
    const base = toInputJsonSchema(z.object({ a: z.string() }));
    const before = JSON.stringify(base);
    applyInputOverlay(base, { target: "x.y", confirmation: "DELETE", forbiddenInputs: { a: "m" } });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("returned schemas are copies: mutating one never changes what is advertised next", () => {
    const tool = MCP_TOOL_MANIFEST.find((item) => item.name === "model_api_token_revoke")!;
    const first = advertised(tool);
    (first.properties as Json).injected = {};
    expect((advertised(tool).properties as Json).injected).toBeUndefined();
  });
});

describe("runtime validation stays with the oRPC procedure", () => {
  it("the SDK-side validator does not enforce required procedure fields", async () => {
    const tool = MCP_TOOL_MANIFEST.find((item) => item.name === "forwarder_pool_fallback_get")!;
    expect(await tool.inputSchema["~standard"].validate({})).not.toHaveProperty("issues");
    expect(
      await tool.inputSchema["~standard"].validate({ poolId: 42, extra: true }),
    ).not.toHaveProperty("issues");
  });

  it("the SDK-side validator still enforces the overlay rules", async () => {
    const revoke = MCP_TOOL_MANIFEST.find((item) => item.name === "model_api_token_revoke")!;
    expect(await revoke.inputSchema["~standard"].validate({ id: "t" })).toHaveProperty("issues");
    expect(
      await revoke.inputSchema["~standard"].validate({ id: "t", confirm: "DELETE" }),
    ).not.toHaveProperty("issues");
  });
});

describe("single source", () => {
  it("no descriptor sets inputSchema by hand or with a loose stand-in", () => {
    const source = readFileSync(new URL("./tool-manifest.ts", import.meta.url), "utf8");
    // Only the descriptor interface field and buildDescriptor mention it.
    expect(source.match(/inputSchema\s*:/g) ?? []).toHaveLength(2);
    expect(source).toMatch(/inputSchema:\s*buildInputSchema\(/);
    expect(source).not.toMatch(/anyArgs|confirmedArgs|looseObject\(\{\}\)/);
    // The generator is the only producer of `inputSchema`.
    expect(source).toContain("buildInputSchema(");
  });
});

describe("manifest size stays within MCP client limits", () => {
  // Measured at this change: largest tool schema ~24.7 KB, all input schemas
  // ~112 KB (78 tools). The real `tools/list` payload (descriptions included)
  // is bounded in tools.test.ts. Limits are ours (MCP publishes no cap).
  const PER_TOOL_MAX_BYTES = 32 * 1024;
  const TOTAL_MAX_BYTES = 160 * 1024;

  it("each tool's input schema and the whole set stay bounded", () => {
    let total = 0;
    for (const tool of MCP_TOOL_MANIFEST) {
      const size = new TextEncoder().encode(JSON.stringify(advertised(tool))).length;
      expect(`${tool.name}: ${size <= PER_TOOL_MAX_BYTES}`).toBe(`${tool.name}: true`);
      total += size;
    }
    expect(total).toBeLessThanOrEqual(TOTAL_MAX_BYTES);
    expect(total).toBeGreaterThan(50_000);
  });

  it("the argument size bound is unchanged", () => {
    expect(MCP_TOOL_INPUT_MAX_BYTES).toBe(64 * 1024);
  });
});
