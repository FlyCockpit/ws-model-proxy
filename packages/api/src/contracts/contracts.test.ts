import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentRulesApply, type CallerAuth, callerMayReach } from "./auth-context";
import { nodeSlugSchema, PRISMA_ENUM_MIRRORS, RESERVED_NODE_SLUGS } from "./common";
import {
  apiContract,
  CSRF_REQUIRED_PROCEDURES,
  flattenContract,
  MCP_EXCLUDED_SESSION_PROCEDURES,
  MCP_READ_TOOLS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  SENSITIVE_INPUT_PROCEDURES,
} from "./index";
import { advertisedToolList } from "./mcp-tools";
import { metricsQueryInputSchema } from "./metrics";

/** Spec §8.1a, with the decisions recorded in docs/contracts/0.4.0.md. */
const INVENTORY = [
  "app.config",
  "app.flags",
  "app.features",
  "auth.inviteInfo",
  "auth.acceptInvite",
  "auth.verifyEmailTransport",
  "auth.updateLocale",
  "auth.passwordCapabilities",
  "settings.get",
  "settings.update",
  "settings.onboarding.complete",
  "users.list",
  "users.invite",
  "users.setRole",
  "users.archive",
  "users.unarchive",
  "users.remove",
  "adminObservability.nodes",
  "adminObservability.runtimes",
  "adminObservability.pools",
  "adminObservability.relay",
  "adminSettings.get",
  "adminSettings.update",
  "nodes.list",
  "nodes.get",
  "nodes.update",
  "nodes.secrets.set",
  "nodes.secrets.delete",
  "nodes.setHold",
  "nodes.setTemporary",
  "nodes.fabrics.list",
  "nodes.fabrics.rename",
  "nodes.fabrics.delete",
  "nodes.rename",
  "nodes.delete",
  "nodes.deleteOffline",
  "nodes.lowerTrustPreview",
  "nodes.lowerTrust",
  "nodes.enrollmentCodes.list",
  "nodes.enrollmentCodes.create",
  "nodes.enrollmentCodes.revoke",
  "nodes.credentials.list",
  "nodes.credentials.revoke",
  "nodes.activity.list",
  "nodes.terminals.openTicket",
  "nodes.queued.list",
  "nodes.queued.enqueue",
  "nodes.queued.run",
  "nodes.queued.dismiss",
  "nodes.commands.run",
  "nodes.commands.get",
  "nodes.files.read",
  "nodes.files.write",
  "nodes.files.edit",
  "runtimes.list",
  "runtimes.get",
  "runtimes.versions.list",
  "runtimes.versions.get",
  "runtimes.presets.list",
  "runtimes.create",
  "runtimes.update",
  "runtimes.delete",
  "runtimes.start",
  "runtimes.stop",
  "runtimes.steps.attach",
  "runtimes.steps.reopen",
  "runtimes.steps.cancel",
  "runtimes.instances.markStopped",
  "runtimes.models.setCapabilities",
  "runtimes.detected.add",
  "runtimes.shares.list",
  "runtimes.shares.create",
  "runtimes.shares.delete",
  "runtimes.fork",
  "profiles.list",
  "profiles.get",
  "profiles.save",
  "profiles.delete",
  "profiles.apply",
  "pools.list",
  "pools.get",
  "pools.history.list",
  "pools.create",
  "pools.update",
  "pools.delete",
  "pools.cloud.setMode",
  "pools.cloud.setPaidWarmProtection",
  "pools.cloud.setOwnKeyEquivalent",
  "pools.routing.setOwnHardwareOnly",
  "pools.members.addContributed",
  "pools.members.removeContributed",
  "pools.rules.delete",
  "pools.aliases.list",
  "pools.aliases.set",
  "pools.aliases.delete",
  "models.list",
  "models.testTargets",
  "models.test",
  "access.apiKeys.list",
  "access.apiKeys.create",
  "access.apiKeys.revoke",
  "access.agentTokens.list",
  "access.agentTokens.create",
  "access.agentTokens.revoke",
  "access.oauthGrants.list",
  "access.oauthGrants.revoke",
  "access.oauthGrants.setLevel",
  "access.shares.list",
  "access.shares.create",
  "access.shares.update",
  "access.shares.delete",
  "access.shares.setOwnKey",
  "access.invites.resend",
  "access.invites.revoke",
  "access.contributing.pools",
  "providers.accounts.list",
  "providers.accounts.get",
  "providers.accounts.create",
  "providers.accounts.update",
  "providers.accounts.delete",
  "providers.accounts.setEnabled",
  "providers.accounts.setDataCollection",
  "providers.credentials.replace",
  "providers.credentials.revoke",
  "providers.credentials.test",
  "providers.credentials.reencrypt",
  "providers.models.list",
  "providers.models.create",
  "providers.models.update",
  "providers.models.delete",
  "providers.pricing.list",
  "providers.pricing.create",
  "providers.pricing.activate",
  "providers.pricing.retire",
  "providers.pricing.delete",
  "providers.catalog.search",
  "providers.usage.list",
  "providers.attempts.list",
  "providers.spendCaps.set",
  "providers.spendCaps.clear",
  "activity.metrics.query",
  "activity.requests.list",
  "activity.requests.delete",
  "activity.commands.list",
  "activity.overview.summary",
  "activity.needsYou.list",
];

/** Spec §1.2 (case-insensitive unless noted). "Relay only" is the trust name and allowed. */
const BANNED: RegExp[] = [
  /\bCLI\b/,
  /\bmachines?\b/i,
  /\bdevices?\b/i,
  /\brelay\b(?![- ]only)/i,
  /\bendpoints?\b/i,
  /\bmodel servers?\b/i,
  /\bdeployments?\b/i,
  /\brecipes?\b/i,
  /\btemplates?\b/i,
  /\bvariants?\b/i,
  /\brevisions?\b/i,
  /\branks?\b/i,
  /\bclaim(s|ed)?\b/i,
  /\bcapacity\b/i,
  /\bexecution targets?\b/i,
  /\bdiscovered models?\b/i,
  /\bdirect models?\b/i,
  /\bmember tiers?\b/i,
  /\bprimary\b/i,
  /\bpublic overflow\b/i,
  /\bguarded\b/i,
  /\bprotected pools?\b/i,
  /\btransformers?\b/i,
  /\boffer(s|ed)?\b/i,
  /\baccept(s|ed)?\b/i,
  /\bgrants?\b/i,
  /\bBYOK\b/i,
  /\begress\b/i,
  /\bbudget (policy|policies|rules?)\b/i,
  /\blayouts?\b/i,
  /\bplans?\b/i,
  /\bask first\b/i,
  /\bsupervised\b/i,
  /\bMCP tokens?\b/i,
  /\bPAT\b/,
  /\bAPI tokens?\b/i,
  /\bforwarders?\b/i,
  /\bunrestricted\b/i,
  /\bmcpCommandMode\b/,
  /\boperate\b/i,
  /\bobserve\b/i,
];

const procedures = new Map(flattenContract(apiContract));

describe("0.4.0 oRPC contract", () => {
  it("has exactly the §8.1a procedures", () => {
    expect([...procedures.keys()].sort()).toEqual([...INVENTORY].sort());
  });

  it("only agent procedures name tools, and every agent procedure has one", () => {
    for (const [path, procedure] of procedures) {
      if (procedure.access === "agent") expect(procedure.tools?.length, path).toBeGreaterThan(0);
      else expect(procedure.tools, path).toBeUndefined();
    }
  });

  it("keeps session procedures off MCP only with a reason", () => {
    const viaTools = new Set(MCP_TOOLS.flatMap((tool) => tool.procedures));
    for (const [path, procedure] of procedures)
      if (procedure.access === "session")
        expect(viaTools.has(path) || path in MCP_EXCLUDED_SESSION_PROCEDURES, path).toBe(true);
    for (const path of Object.keys(MCP_EXCLUDED_SESSION_PROCEDURES))
      expect(procedures.get(path)?.access, path).toBe("session");
  });

  it("mirrors the Prisma enums exactly", () => {
    const dir = fileURLToPath(new URL("../../../db/prisma/schema/", import.meta.url));
    const text = readdirSync(dir)
      .filter((name) => name.endsWith(".prisma"))
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("\n");
    const enums = new Map<string, string[]>();
    for (const match of text.matchAll(/^enum (\w+) \{([^}]*)\}/gm))
      enums.set(
        match[1] ?? "",
        (match[2] ?? "")
          .split("\n")
          .map((line) => line.replace(/\/\/.*$/, "").trim())
          .filter((line) => /^\w+$/.test(line)),
      );
    for (const [name, values] of Object.entries(PRISMA_ENUM_MIRRORS))
      expect(enums.get(name), name).toEqual([...values]);
  });
});

describe("caller auth (positive human check)", () => {
  const callers: Record<string, CallerAuth> = {
    cookie: { kind: "cookie_session", userId: "u", sessionId: "s", csrfVerified: true },
    cookieNoCsrf: { kind: "cookie_session", userId: "u", sessionId: "s", csrfVerified: false },
    fullAgent: { kind: "agent_token", userId: "u", agentTokenId: "t", level: "FULL" },
    oauth: { kind: "oauth_access_token", userId: "u", grantId: "g", level: "FULL" },
    apiKey: { kind: "api_key", userId: "u", apiKeyId: "k" },
  };

  it("lets only a CSRF-checked cookie session reach human procedures", () => {
    for (const [path, procedure] of procedures) {
      if (procedure.access !== "human" && procedure.access !== "human_admin") continue;
      expect(callerMayReach(procedure.access, callers.cookie as CallerAuth), path).toBe(true);
      for (const name of ["cookieNoCsrf", "fullAgent", "oauth", "apiKey"])
        expect(
          callerMayReach(procedure.access, callers[name] as CallerAuth),
          `${path} ${name}`,
        ).toBe(false);
    }
  });

  it("requires the CSRF header on every human procedure (queries included) and agent mutation", () => {
    expect(CSRF_REQUIRED_PROCEDURES.has("nodes.lowerTrustPreview")).toBe(true);
    expect(CSRF_REQUIRED_PROCEDURES.has("runtimes.start")).toBe(true);
    expect(CSRF_REQUIRED_PROCEDURES.has("nodes.list")).toBe(false);
    for (const [path, procedure] of procedures)
      expect(CSRF_REQUIRED_PROCEDURES.has(path), path).toBe(
        procedure.access === "human" ||
          procedure.access === "human_admin" ||
          (procedure.access === "agent" && procedure.kind === "mutation"),
      );
  });

  it("treats a cookie that failed the CSRF check as not a person for agent rules", () => {
    expect(agentRulesApply(callers.cookie as CallerAuth)).toBe(false);
    for (const name of ["cookieNoCsrf", "fullAgent", "oauth", "apiKey"])
      expect(agentRulesApply(callers[name] as CallerAuth), name).toBe(true);
  });

  it("refuses tokens on session and admin procedures; API keys reach no procedure", () => {
    for (const [path, procedure] of procedures) {
      if (procedure.access === "session" || procedure.access === "admin")
        for (const name of ["fullAgent", "oauth", "apiKey"])
          expect(
            callerMayReach(procedure.access, callers[name] as CallerAuth),
            `${path} ${name}`,
          ).toBe(false);
      if (procedure.access !== "public")
        expect(callerMayReach(procedure.access, callers.apiKey as CallerAuth), path).toBe(false);
    }
  });
});

describe("id formats", () => {
  // The ids the server mints: cuid2 row ids (Prisma `@default(cuid(2))`, 24 chars here; the
  // length is configurable) and the 22-char base64url ids of node commands. Any id one tool
  // returns must be accepted wherever another takes it (older rows: cuid v1, Better Auth ids), so every `id`/`*Id`/`*Ids` input field
  // accepts all of them (node_command_get once took only 22 chars and refused queued ids).
  const MINTED_IDS = [
    "x9k2m4p6r8t0v1w3y5z7a9b1",
    "AbC-_dEfGhIjKlMnOpQrSt",
    "ckh3d0k1q0000a1b2c3d4e5f6",
    "Xk3P0aQz9LmN2bVc8RtY6uWe4SdF1gHj",
  ];
  type Json = { [key: string]: unknown };
  function idFields(schema: unknown, at: string, out: Array<[string, Json]>): void {
    if (Array.isArray(schema)) {
      for (const [index, entry] of schema.entries()) idFields(entry, `${at}[${index}]`, out);
      return;
    }
    if (typeof schema !== "object" || schema === null) return;
    const node = schema as Json;
    const properties = node.properties as Record<string, Json> | undefined;
    for (const [key, value] of Object.entries(properties ?? {})) {
      if (/^(id|.*Id)$/.test(key)) out.push([`${at}.${key}`, value]);
      if (/Ids$/.test(key) && typeof value.items === "object")
        out.push([`${at}.${key}[]`, value.items as Json]);
    }
    for (const value of Object.values(node)) idFields(value, at, out);
  }
  function stringPatterns(schema: Json): string[] {
    const options = [schema, ...((schema.anyOf as Json[] | undefined) ?? [])];
    return options.flatMap((option) =>
      option.type === "string" && typeof option.pattern === "string" ? [option.pattern] : [],
    );
  }

  it("accepts every minted id format in every id input field", () => {
    const inputs: Array<[string, z.ZodType]> = [
      ...Array.from(procedures, ([path, procedure]): [string, z.ZodType] => [
        path,
        procedure.input,
      ]),
      ...MCP_TOOLS.map((tool): [string, z.ZodType] => [`mcp:${tool.name}`, tool.input]),
    ];
    let checked = 0;
    for (const [name, input] of inputs) {
      const fields: Array<[string, Json]> = [];
      idFields(z.toJSONSchema(input, { io: "input", unrepresentable: "any" }), name, fields);
      for (const [path, field] of fields)
        for (const pattern of stringPatterns(field)) {
          checked += 1;
          for (const id of MINTED_IDS)
            expect(new RegExp(pattern).test(id), `${path} ${id}`).toBe(true);
        }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe("0.4.0 MCP tool manifest", () => {
  it("has the 28 tools in order, 7 of them read-only", () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
    expect(MCP_TOOLS.filter((tool) => tool.level === "READ").map((tool) => tool.name)).toEqual([
      ...MCP_READ_TOOLS,
    ]);
    expect(MCP_TOOLS).toHaveLength(28);
  });

  it("calls only agent procedures that name the tool back; read tools only query", () => {
    for (const tool of MCP_TOOLS)
      for (const path of tool.procedures) {
        const procedure = procedures.get(path);
        expect(procedure?.access, `${tool.name} → ${path}`).toBe("agent");
        expect(procedure?.tools, `${tool.name} → ${path}`).toContain(tool.name);
        if (tool.level === "READ") expect(procedure?.kind, `${tool.name} → ${path}`).toBe("query");
      }
    for (const [path, procedure] of procedures)
      for (const name of procedure.tools ?? [])
        expect(
          MCP_TOOLS.find((tool) => tool.name === name)?.procedures,
          `${path} names ${name}`,
        ).toContain(path);
  });

  it("requires confirm on deletes and command runs", () => {
    for (const name of ["pool_delete", "runtime_delete", "profile_delete", "node_delete"]) {
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      expect(
        tool?.input.safeParse({ poolId: "p", runtimeId: "r", profileId: "x", nodeId: "n" }).success,
      ).toBe(false);
    }
    const run = MCP_TOOLS.find((entry) => entry.name === "node_command_run");
    expect(run?.input.safeParse({ nodeId: "n", command: "ls" }).success).toBe(false);
    expect(run?.input.safeParse({ nodeId: "n", command: "ls", confirm: "RUN" }).success).toBe(true);
  });

  it("uses the user's words in names and descriptions", () => {
    for (const tool of MCP_TOOLS)
      for (const pattern of BANNED) {
        expect(pattern.test(tool.description), `${tool.name}: ${pattern}`).toBe(false);
        expect(pattern.test(tool.name.replaceAll("_", " ")), `${tool.name}: ${pattern}`).toBe(
          false,
        );
      }
  });

  it("keeps tools/list within its token budget (chars / 4)", () => {
    // Measured 2026-10-06: 13,223 tokens before the owner's token-efficiency pass (25 tools),
    // 5,506 after it (26 tools). Raise only with a reason in the commit message.
    // The server's real tools/list (titles, annotations, output schemas) is measured by the
    // MCP server's own budget test (apps/server/src/mcp).
    const text = JSON.stringify({ tools: advertisedToolList() });
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(6_500);
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(400);
      expect(
        tool.description.split(/[.!?](\s|$)/).filter((part) => part.trim()).length,
        tool.name,
      ).toBeLessThanOrEqual(4);
    }
  });

  it("advertises compact fields with the JSON type the procedure takes (object, list, null)", () => {
    const typesOf = (schema: Record<string, unknown>): string[] => {
      if (typeof schema.type === "string") return [schema.type];
      if (Array.isArray(schema.type)) return schema.type as string[];
      const branches = (schema.anyOf ?? []) as Array<Record<string, unknown>>;
      return branches.flatMap(typesOf);
    };
    for (const tool of MCP_TOOLS)
      for (const field of Object.keys(tool.compactFields ?? {})) {
        const full = z.toJSONSchema(tool.input, { io: "input" }) as {
          properties: Record<string, Record<string, unknown>>;
        };
        const schema = advertisedToolList().find((entry) => entry.name === tool.name)?.inputSchema;
        const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
        const advertised = properties[field] ?? {};
        expect(typesOf(advertised).sort(), `${tool.name}.${field}`).toEqual(
          typesOf(full.properties[field] ?? {}).sort(),
        );
      }
    const nodeUpdate = advertisedToolList().find((entry) => entry.name === "node_update");
    const fields = (nodeUpdate?.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>;
    // metricCommands is a list in nodes.update; hardware takes null to clear.
    expect(fields.metricCommands?.type).toBe("array");
    expect(fields.hardware?.type).toEqual(["object", "null"]);
  });

  it("keeps secret values out of generic inputs (only the sensitive secret tool takes one)", () => {
    expect(
      procedures.get("nodes.update")?.input.safeParse({
        nodeId: "n",
        secrets: { set: [{ name: "WSMP_SECRET_X", value: "v" }] },
      }).success,
    ).toBe(false);
    for (const path of SENSITIVE_INPUT_PROCEDURES) expect(procedures.has(path), path).toBe(true);
    expect(MCP_TOOLS.filter((tool) => tool.sensitiveInput).map((tool) => tool.name)).toEqual([
      "node_secret_set",
    ]);
    const secretTool = MCP_TOOLS.find((tool) => tool.name === "node_secret_set");
    for (const path of secretTool?.procedures ?? [])
      expect(path.startsWith("nodes.secrets."), path).toBe(true);
  });

  it("takes a secret value only in a listed sensitive procedure", () => {
    /** Property paths of a JSON Schema (objects, arrays, unions). */
    const paths = (schema: unknown, prefix: string[] = []): string[][] => {
      if (!schema || typeof schema !== "object") return [];
      const node = schema as Record<string, unknown>;
      const out: string[][] = [];
      for (const [key, child] of Object.entries(
        (node.properties ?? {}) as Record<string, unknown>,
      )) {
        out.push([...prefix, key], ...paths(child, [...prefix, key]));
      }
      for (const key of ["items", "additionalProperties"] as const)
        if (node[key] && typeof node[key] === "object") out.push(...paths(node[key], prefix));
      for (const key of ["anyOf", "oneOf", "allOf"] as const)
        for (const branch of (node[key] as unknown[] | undefined) ?? [])
          out.push(...paths(branch, prefix));
      return out;
    };
    const offenders: string[] = [];
    for (const [path, procedure] of procedures) {
      const schema = z.toJSONSchema(procedure.input, { io: "input", unrepresentable: "any" });
      for (const property of paths(schema)) {
        const full = [...path.split("."), ...property].join(".");
        if (
          property.at(-1) === "value" &&
          /secret/i.test(full) &&
          !SENSITIVE_INPUT_PROCEDURES.has(path)
        )
          offenders.push(full);
      }
    }
    expect(offenders).toEqual([]);
    // The rule sees the one procedure that does take a value.
    const setSchema = z.toJSONSchema(procedures.get("nodes.secrets.set")?.input ?? z.object({}), {
      io: "input",
      unrepresentable: "any",
    });
    expect(paths(setSchema).map((property) => property.join("."))).toContain("value");
  });

  it("forks return what create returns and take the same settings", () => {
    expect(procedures.get("runtimes.fork")?.output).toBe(procedures.get("runtimes.create")?.output);
    expect(
      procedures.get("runtimes.fork")?.input.safeParse({
        runtimeId: "r",
        slug: "copy",
        name: "Copy",
        limits: {},
        note: "why",
      }).success,
    ).toBe(true);
  });

  it("converts every tool schema to JSON Schema", () => {
    for (const tool of MCP_TOOLS) {
      expect(() => z.toJSONSchema(tool.input, { io: "input" }), tool.name).not.toThrow();
      expect(() => z.toJSONSchema(tool.output, { io: "output" }), tool.name).not.toThrow();
    }
  });
});

describe("metrics_query input", () => {
  const base = { metrics: ["ttft_p95"], range: "24h", step: "5m" } as const;

  it("accepts groupBy keys the rollups have", () => {
    expect(
      metricsQueryInputSchema.safeParse({ ...base, scope: { pool: "p" }, groupBy: "member" })
        .success,
    ).toBe(true);
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        scope: { node: "n" },
        metrics: ["custom:gpu_power"],
      }).success,
    ).toBe(true);
  });

  it("caps each family to what its tables keep", () => {
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        scope: { pool: "p" },
        metrics: ["kv_usage_max"],
        range: "30d",
        step: "1h",
      }).success,
    ).toBe(false);
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        scope: { pool: "p" },
        range: { from: "2026-01-01T00:00:00Z", to: "2026-06-01T00:00:00Z" },
        step: "1d",
      }).success,
    ).toBe(true);
  });

  it("refuses groupBy values a scope or family cannot have, and minute steps past 30 days", () => {
    expect(
      metricsQueryInputSchema.safeParse({ ...base, scope: { instance: "i" }, groupBy: "node" })
        .success,
    ).toBe(false);
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        metrics: ["kv_usage_max"],
        scope: { pool: "p" },
        groupBy: "member",
      }).success,
    ).toBe(false);
    expect(
      metricsQueryInputSchema.safeParse({
        ...base,
        scope: { pool: "p" },
        range: { from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" },
      }).success,
    ).toBe(false);
  });
});

describe("node slugs (shared with the CLI)", () => {
  it("reserves the same names as apps/cli/src/slug.rs", () => {
    const rust = readFileSync(
      fileURLToPath(new URL("../../../../apps/cli/src/slug.rs", import.meta.url)),
      "utf8",
    );
    const block = /const RESERVED: &\[&str\] = &\[([^\]]*)\];/.exec(rust)?.[1] ?? "";
    const names = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual([...RESERVED_NODE_SLUGS]);
  });

  it("takes 3–63 characters and refuses reserved names", () => {
    expect(nodeSlugSchema.safeParse("desk-01").success).toBe(true);
    expect(nodeSlugSchema.safeParse("a".repeat(63)).success).toBe(true);
    expect(nodeSlugSchema.safeParse("ab").success).toBe(false);
    expect(nodeSlugSchema.safeParse("a".repeat(64)).success).toBe(false);
    expect(nodeSlugSchema.safeParse("api").success).toBe(false);
    expect(nodeSlugSchema.safeParse("desk--01").success).toBe(false);
    expect(nodeSlugSchema.safeParse("-desk").success).toBe(false);
  });
});
