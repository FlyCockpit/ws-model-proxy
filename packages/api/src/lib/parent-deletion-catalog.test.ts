import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DeletedParentTable,
  HISTORY_DRAIN_EDGES,
  OWNER_RETAINED_HISTORY_TABLES,
  PARENT_DELETE_TRIGGER_WORK,
  RETAINED_HISTORY_EDGES,
  resolveDeletedParents,
} from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

// DL1-TXBOUND class check: the parent-deletion contract (which history tables
// are drained through which foreign keys before an ordered delete, and which
// RESTRICT edges its preflight covers) must match the Prisma schema. A new
// foreign key into the user's graph fails here until it is classified, so the
// locked cascade cannot silently grow a traffic-proportional table again.

type Action = "Cascade" | "SetNull" | "Restrict" | "NoAction" | "SetDefault";
type Edge = { child: string; column: string; parent: string; action: Action };

const schemaDir = join(import.meta.dirname, "../../../db/prisma/schema");

function loadEdges(): { edges: Edge[]; tables: Set<string> } {
  const models = new Map<string, { table: string; body: string }>();
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".prisma"))) {
    const source = readFileSync(join(schemaDir, file), "utf8");
    for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const [, name = "", body = ""] = match;
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
      models.set(name, { table, body });
    }
  }
  const edges: Edge[] = [];
  for (const { table, body } of models.values()) {
    for (const line of body.split("\n")) {
      const relation = /@relation\(([^)]*fields:[^)]*)\)/.exec(line)?.[1];
      if (!relation) continue;
      const type = line.trim().split(/\s+/)[1] ?? "";
      const referenced = models.get(type.replace(/[?[\]]/g, ""));
      if (!referenced) throw new Error(`Unknown relation type in ${table}: ${line.trim()}`);
      const fields = (/fields:\s*\[([^\]]*)\]/.exec(relation)?.[1] ?? "")
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean);
      // Prisma's defaults: SetNull for an optional relation, Restrict otherwise.
      const action = (/onDelete:\s*(\w+)/.exec(relation)?.[1] ??
        (type.endsWith("?") ? "SetNull" : "Restrict")) as Action;
      // Composite keys carry the owner id next to the real reference.
      const column = fields.find((field) => field !== "userId") ?? fields[0] ?? "";
      edges.push({ child: table, column, parent: referenced.table, action });
    }
  }
  return { edges, tables: new Set([...models.values()].map((model) => model.table)) };
}

const { edges, tables } = loadEdges();

/** Tables a `"user"` DELETE removes rows from (CASCADE closure). */
function cascadeReach(root: string): Set<string> {
  const reach = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const edge of edges)
      if (edge.action === "Cascade" && reach.has(edge.parent) && !reach.has(edge.child)) {
        reach.add(edge.child);
        grew = true;
      }
  }
  return reach;
}

const reach = cascadeReach("user");
const history = new Set(Object.keys(HISTORY_DRAIN_EDGES));

/**
 * Tables the cascade deletes inside the ordered transaction, and why their
 * size is bounded by configuration (or by their own retention), not by
 * request traffic.
 */
const GRAPH_TABLES: Record<string, string> = {
  user: "the root",
  session: "browser sessions (expiry sweep)",
  account: "sign-in methods",
  two_factor: "one per user",
  device_code: "short-lived device-flow codes",
  oauth_client: "registered OAuth clients",
  oauth_client_resource: "per client",
  oauth_consent: "per client",
  oauth_access_token: "OAuth tokens (retention cleanup)",
  oauth_refresh_token: "OAuth tokens (retention cleanup)",
  mcp_grant: "per client grant",
  mcp_personal_token: "personal tokens",
  dashboard_notice: "notices",
  cli_device: "configuration",
  cli_device_credential: "configuration",
  cli_token: "configuration",
  endpoint: "configuration",
  discovered_model: "configuration",
  execution_target: "configuration",
  inference_capacity: "configuration",
  model_pool: "configuration",
  pool_member: "configuration",
  pool_grant: "configuration",
  model_api_token: "configuration",
  model_api_token_allowlist_entry: "configuration",
  provider_account: "configuration",
  provider_model: "configuration",
  provider_credential: "configuration",
  provider_budget_policy: "configuration",
  provider_budget_rule: "configuration",
  cache_affinity_record: "bounded per pool (affinityMaxRecords) and swept",
  capacity_audit_event: "one row per owner policy edit, not per request",
  media_asset: "uploads, deleted at expiry by the media cleanup",
};

/** Tables whose rows make the delete fail; the preflight refuses first. */
const RETAINED_TABLES = new Set<string>(["capacity_lease", ...OWNER_RETAINED_HISTORY_TABLES]);

describe("parent-deletion contract against the Prisma schema", () => {
  it("classifies every table a user delete cascades into or rewrites", () => {
    const touched = new Set(reach);
    for (const edge of edges)
      if (edge.action === "SetNull" && reach.has(edge.parent)) touched.add(edge.child);
    const unclassified = [...touched]
      .filter(
        (table) => !history.has(table) && !(table in GRAPH_TABLES) && !RETAINED_TABLES.has(table),
      )
      .sort();
    expect(unclassified).toEqual([]);
    // No stale classification.
    for (const table of [...history, ...Object.keys(GRAPH_TABLES)])
      expect(tables.has(table), table).toBe(true);
  });

  it("drains every foreign key from a history table into the deleted graph, with its action", () => {
    for (const [table, spec] of Object.entries(HISTORY_DRAIN_EDGES)) {
      const actual = edges
        .filter((edge) => edge.child === table)
        .map((edge) => `${edge.column}->${edge.parent}:${edge.action}`)
        .sort();
      const declared = [
        ...spec.cascade.map(([column, parent]) => `${column}->${parent}:Cascade`),
        ...spec.setNull.map(([column, parent]) => `${column}->${parent}:SetNull`),
      ];
      const internal = new Set<string>(spec.internal);
      const external = actual.filter((entry) => !internal.has(entry.split("->")[0] ?? ""));
      expect(external, table).toEqual(declared.sort());
      // Internal edges point at another drained history table.
      for (const edge of edges.filter((e) => e.child === table && internal.has(e.column)))
        expect(history.has(edge.parent), `${table}.${edge.column}`).toBe(true);
    }
  });

  it("resolves the exact parent chains for every production delete scope", async () => {
    // Each delegate answers with its own distinct rows (whatever the filter),
    // so every step of the resolution chain is visible in the result.
    const rows: Record<string, Array<Record<string, string>>> = {
      cliDevice: [{ id: "device-1" }],
      endpoint: [{ id: "endpoint-1" }],
      discoveredModel: [{ id: "model-1" }],
      executionTarget: [{ id: "target-1", discoveredModelId: "model-of-target" }],
      modelPool: [{ id: "pool-1" }],
      poolMember: [{ id: "member-1" }],
      poolGrant: [{ id: "grant-1" }],
      inferenceCapacity: [{ id: "capacity-1" }],
      modelApiToken: [{ id: "token-1" }],
      providerAccount: [{ id: "provider-account-1" }],
      providerModel: [{ id: "provider-model-1" }],
    };
    const db = Object.fromEntries(
      Object.entries(rows).map(([delegate, list]) => [delegate, { findMany: async () => list }]),
    );
    const none: Record<DeletedParentTable, string[]> = {
      user: [],
      model_pool: [],
      pool_member: [],
      pool_grant: [],
      discovered_model: [],
      execution_target: [],
      inference_capacity: [],
      model_api_token: [],
      provider_account: [],
      provider_model: [],
    };
    const cases: Array<{
      label: string;
      scope: Parameters<typeof resolveDeletedParents>[1];
      expected: Record<DeletedParentTable, string[]>;
    }> = [
      {
        label: "whole user",
        scope: { userId: "u", wholeUser: true },
        expected: {
          user: ["u"],
          model_pool: ["pool-1"],
          pool_member: ["member-1"],
          pool_grant: ["grant-1"],
          discovered_model: ["model-1", "model-of-target"],
          execution_target: ["target-1"],
          inference_capacity: ["capacity-1"],
          model_api_token: ["token-1"],
          provider_account: ["provider-account-1"],
          provider_model: ["provider-model-1"],
        },
      },
      {
        label: "model pool",
        scope: { userId: "u", poolIds: ["p"] },
        expected: {
          ...none,
          model_pool: ["p"],
          pool_member: ["member-1"],
          pool_grant: ["grant-1"],
        },
      },
      {
        label: "pool member",
        scope: { userId: "u", poolMemberIds: ["m"] },
        expected: { ...none, pool_member: ["m"] },
      },
      {
        label: "execution target",
        scope: { userId: "u", executionTargetIds: ["t"] },
        expected: {
          ...none,
          execution_target: ["t"],
          discovered_model: ["model-of-target"],
          pool_member: ["member-1"],
        },
      },
      {
        label: "inference capacity",
        scope: { userId: "u", capacityIds: ["c"] },
        expected: { ...none, inference_capacity: ["c"] },
      },
      {
        label: "discovered model",
        scope: { userId: "u", discoveredModelIds: ["dm"] },
        expected: {
          ...none,
          discovered_model: ["dm", "model-of-target"],
          execution_target: ["target-1"],
          pool_member: ["member-1"],
        },
      },
      {
        label: "endpoint",
        scope: { userId: "u", endpointIds: ["e"] },
        expected: {
          ...none,
          discovered_model: ["model-1", "model-of-target"],
          execution_target: ["target-1"],
          pool_member: ["member-1"],
        },
      },
      {
        label: "cli device",
        scope: { userId: "u", cliDeviceIds: ["d"] },
        expected: {
          ...none,
          discovered_model: ["model-1", "model-of-target"],
          execution_target: ["target-1"],
          pool_member: ["member-1"],
        },
      },
    ];
    for (const { label, scope, expected } of cases)
      expect(await resolveDeletedParents(db as never, scope), label).toEqual(expected);
  });

  it("classifies every DELETE trigger on a table the delete reaches (schema-hardening.sql)", () => {
    const hardening = readFileSync(
      join(import.meta.dirname, "../../../db/prisma/schema-hardening.sql"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ");
    const touched = new Set(reach);
    for (const edge of edges)
      if (edge.action === "SetNull" && reach.has(edge.parent)) touched.add(edge.child);
    // Every trigger whose events include DELETE, on any table.
    const deleteTriggers = [
      ...hardening.matchAll(
        /CREATE\s+TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\s+ON\s+"?(\w+)"?/gi,
      ),
    ]
      .filter((match) => /\bDELETE\b/i.test(match[3] ?? ""))
      .map((match) => ({
        id: match[1] ?? "",
        timing: `${(match[2] ?? "").toUpperCase()} DELETE`,
        table: match[4] ?? "",
      }));
    // The parser sees the known one (a control for the pattern itself).
    expect(deleteTriggers.map((trigger) => trigger.id)).toContain("usage_rollup_detach_requester");
    const onReachedTables = deleteTriggers.filter((trigger) => touched.has(trigger.table));
    const declared = PARENT_DELETE_TRIGGER_WORK.map((entry) => ({
      id: entry.id,
      timing: entry.timing,
      table: entry.parentTable,
    }));
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect(onReachedTables.sort(byId)).toEqual([...declared].sort(byId));
    // DELETE triggers elsewhere sit on retained history the preflight refuses
    // (RESTRICT) or on tables the delete never reaches.
    for (const trigger of deleteTriggers.filter((t) => !touched.has(t.table)))
      expect(
        RETAINED_TABLES.has(trigger.table) || !reach.has(trigger.table),
        `${trigger.id} on ${trigger.table}`,
      ).toBe(true);
  });

  it("covers every RESTRICT edge into the deleted graph with the preflight", () => {
    const restrict = edges
      .filter(
        (edge) =>
          (edge.action === "Restrict" || edge.action === "NoAction") && reach.has(edge.parent),
      )
      .map((edge) => `${edge.child}.${edge.column}`)
      .sort();
    expect(Object.keys(RETAINED_HISTORY_EDGES).sort()).toEqual(restrict);
    // owner-history edges come only from tables the preflight checks by
    // owner, plus the rotation link it checks apart.
    for (const [edge, coverage] of Object.entries(RETAINED_HISTORY_EDGES)) {
      const table = edge.split(".")[0] ?? "";
      if (coverage === "owner-history" && edge !== "provider_credential.replacedById")
        expect(OWNER_RETAINED_HISTORY_TABLES, edge).toContain(table);
      if (coverage === "lease") expect(table).toBe("capacity_lease");
    }
  });
});
