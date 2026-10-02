import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOT_PATH_TABLES } from "@ws-model-proxy/db/capacity-lock-order";
import {
  type DeletedParentTable,
  HISTORY_DRAIN_EDGES,
  OWNER_RETAINED_HISTORY_TABLES,
  RETAINED_HISTORY_EDGES,
  resolveDeletedParents,
  USER_PLAIN_ID_HISTORY_TABLES,
} from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

// The parent-deletion contract against the Prisma schema (DL-1 design (d),
// #78): a delete cascades only into graph and bounded auxiliary tables (no
// hot-path table has a foreign key into the graph), every hot-path table is
// in the user-history contract with real columns, and the preflight covers
// every RESTRICT edge. A new foreign key into the user's graph fails here
// until it is classified, so the delete cannot silently grow a
// traffic-proportional cascade again.

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
  cli_device: "configuration",
  cli_device_credential: "configuration",
  cli_token: "configuration",
  endpoint: "configuration",
  discovered_model: "configuration",
  execution_target: "configuration",
  inference_capacity: "configuration",
  model_pool: "configuration",
  pool_member: "configuration",
  pool_routing_rule: "configuration: at most 16 rules per pool",
  pool_grant: "configuration",
  pool_fallback_preference: "configuration: at most one per exact pool grant",
  model_api_token: "configuration",
  model_api_token_allowlist_entry: "configuration",
  provider_account: "configuration",
  provider_model: "configuration",
  provider_credential: "configuration",
  provider_budget_policy: "configuration",
  provider_budget_rule: "configuration",
  capacity_audit_event: "one row per owner policy edit, not per request",
  media_asset: "uploads, deleted at expiry by the media cleanup",
};

/** Tables whose rows make the delete fail; the preflight refuses first. */
const RETAINED_TABLES = new Set<string>(OWNER_RETAINED_HISTORY_TABLES);
const hot = new Set<string>(HOT_PATH_TABLES);

/**
 * DELETE triggers on tables a user delete reaches, and the work each adds:
 * none of them writes rows.
 */
const REACHED_DELETE_TRIGGERS: Record<string, string> = {
  "z_graph_write_fence:user":
    "graph-write fence check (plain reads); the user delete holds the owner fences",
  "provider_audit_event_immutable:provider_audit_event":
    "retained history the preflight refuses; never fires on a delete that proceeds",
};

/**
 * Tables with an owner `userId` column that is NOT a foreign key: the cascade
 * never reaches them, so each must be drained (USER_PLAIN_ID_HISTORY_TABLES)
 * or listed here with the reason a user delete may leave the rows.
 */
const PLAIN_USER_ID_EXEMPT: Record<string, string> = {};

/** Tables with a plain `userId` column (owner) and no relation on it. */
function plainUserIdTables(): Array<{ table: string; column: string }> {
  const found: Array<{ table: string; column: string }> = [];
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".prisma"))) {
    const source = readFileSync(join(schemaDir, file), "utf8");
    for (const match of source.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const [, name = "", body = ""] = match;
      const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
      const related = new Set<string>();
      for (const line of body.split("\n")) {
        const fields = /fields:\s*\[([^\]]*)\]/.exec(line)?.[1];
        for (const field of (fields ?? "").split(",")) related.add(field.trim());
      }
      for (const line of body.split("\n")) {
        const [column = "", type = ""] = line.trim().split(/\s+/);
        if (column === "userId" && type.startsWith("String") && !related.has(column))
          found.push({ table, column });
      }
    }
  }
  return found;
}

describe("plain user-id tables", () => {
  it("classifies every table with a user id column that has no foreign key", () => {
    const unclassified = plainUserIdTables().filter(
      ({ table }) =>
        !(table in USER_PLAIN_ID_HISTORY_TABLES) &&
        !(table in PLAIN_USER_ID_EXEMPT) &&
        // Hot-path history is drained by HISTORY_DRAIN_EDGES and the
        // `deleted_user_purge` sweeper (#78); the queue table itself is
        // hot-path bookkeeping keyed by the deleted user.
        !hot.has(table) &&
        table !== "deleted_user_purge",
    );
    expect(unclassified).toEqual([]);
  });

  it("drains cli_agent_action_event by its userId column", () => {
    expect(USER_PLAIN_ID_HISTORY_TABLES.cli_agent_action_event.userColumn).toBe("userId");
    expect(plainUserIdTables()).toContainEqual({
      table: "cli_agent_action_event",
      column: "userId",
    });
  });

  it("has no stale classification", () => {
    const actual = new Set(plainUserIdTables().map(({ table }) => table));
    for (const table of [
      ...Object.keys(USER_PLAIN_ID_HISTORY_TABLES),
      ...Object.keys(PLAIN_USER_ID_EXEMPT),
    ])
      expect(actual.has(table), table).toBe(true);
  });
});

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

  it("keeps every hot-path table out of the delete's cascade and in the user-history contract", () => {
    // No foreign key crosses between a hot-path table and any other table
    // (in either direction), so no delete reaches one.
    const crossing = edges
      .filter((edge) => hot.has(edge.child) !== hot.has(edge.parent))
      .map((edge) => `${edge.child}.${edge.column} -> ${edge.parent}`);
    expect(crossing).toEqual([]);
    expect([...reach].filter((table) => hot.has(table))).toEqual([]);
    // The history contract names exactly the hot-path tables.
    expect(Object.keys(HISTORY_DRAIN_EDGES).sort()).toEqual([...hot].sort());
    const models = readdirSync(schemaDir)
      .filter((name) => name.endsWith(".prisma"))
      .map((name) => readFileSync(join(schemaDir, name), "utf8"))
      .join("\n");
    for (const [table, spec] of Object.entries(HISTORY_DRAIN_EDGES)) {
      const body = [...models.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].find(
        (match) => (/@@map\("([^"]+)"\)/.exec(match[2] ?? "")?.[1] ?? match[1]) === table,
      )?.[2];
      expect(body, table).toBeDefined();
      // Every user column the purge deletes by exists on the table.
      for (const [column] of spec.delete)
        expect(new RegExp(`^\\s+${column}\\s`, "m").test(body ?? ""), `${table}.${column}`).toBe(
          true,
        );
      // Internal keys are foreign keys to another hot-path table.
      const internal = new Set<string>(spec.internal);
      for (const edge of edges.filter((e) => e.child === table))
        expect(internal.has(edge.column) && hot.has(edge.parent), `${table}.${edge.column}`).toBe(
          true,
        );
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
    expect(deleteTriggers.map((trigger) => trigger.id)).toContain("z_graph_write_fence");
    const onReachedTables = deleteTriggers
      .filter((trigger) => touched.has(trigger.table))
      .map((trigger) => `${trigger.id}:${trigger.table}`)
      .sort();
    expect(onReachedTables).toEqual(Object.keys(REACHED_DELETE_TRIGGERS).sort());
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
    }
  });
});
