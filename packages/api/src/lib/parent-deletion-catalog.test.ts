import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOT_PATH_TABLES } from "@ws-model-proxy/db/capacity-lock-order";
import {
  DELETE_ORDER_EDGES,
  type DeletedParentTable,
  HISTORY_DRAIN_EDGES,
  resolveDeletedParents,
  USER_PLAIN_ID_HISTORY_TABLES,
} from "@ws-model-proxy/db/parent-deletion";
import { describe, expect, it } from "vitest";

// The parent-deletion contract against the Prisma schema (DL-1 design (d),
// #78): a delete cascades only into graph and bounded auxiliary tables (no
// hot-path table has a foreign key into the graph), every hot-path table is
// in the user-history contract with real columns, and every NoAction/RESTRICT
// edge is handled by the ordered whole-user delete. A new foreign key into the user's graph fails here
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
  oauth_client: "registered OAuth clients",
  oauth_client_resource: "per client",
  oauth_consent: "per client",
  oauth_access_token: "OAuth tokens (retention cleanup)",
  oauth_refresh_token: "OAuth tokens (retention cleanup)",
  mcp_grant: "per client grant",
  agent_token: "agent tokens",
  node: "configuration",
  node_credential: "one active per node",
  node_enrollment_code: "short-lived codes",
  node_enrollment_use: "one row per enrolled node",
  node_command: "node command state, 30-day retention",
  queued_node_command: "commands queued for a person, expire",
  fabric: "configuration",
  fabric_member: "configuration",
  runtime: "configuration",
  runtime_version: "immutable configuration versions",
  runtime_model: "configuration",
  runtime_share: "two-party configuration",
  runtime_instance: "running copies; released by the delete",
  instance_rank: "one per instance node",
  instance_step: "bounded lifecycle steps per instance",
  runtime_operation: "bounded operations",
  execution_target: "configuration",
  profile: "configuration",
  profile_node: "configuration",
  profile_item: "configuration",
  pool: "configuration",
  pool_routing: "1:1 with a pool",
  pool_fallback: "1:1 with a pool",
  pool_advanced: "1:1 with a pool",
  pool_sidecar: "at most 3 per pool",
  pool_member: "configuration",
  pool_routing_rule: "configuration: at most 16 rules per pool",
  api_key: "configuration",
  api_key_pool: "configuration",
  share: "two-party configuration",
  share_invite: "pending invites",
  provider_account: "configuration",
  provider_model: "configuration",
  provider_credential: "configuration",
  provider_pricing_version: "configuration versions",
  spend_cap: "configuration",
  media_asset: "uploads, deleted at expiry by the media cleanup",
};

const hot = new Set<string>(HOT_PATH_TABLES);

/**
 * DELETE triggers on tables a user delete reaches, and the work each adds:
 * none of them writes traffic-proportional rows.
 */
const REACHED_DELETE_TRIGGERS: Record<string, string> = {
  "node_delete_release:node":
    "releases the node's ranks, stops what had a part there, deletes its always-on instances; bounded by the node's instances",
  "pool_routing_rule_on_member_delete:pool_member":
    "rewrites at most 16 pool_routing_rule rows of the pool; configuration, not per-request",
  "share_delete_cleanup:share":
    "removes the grantee's API-key entries and sidecar links for the pool; configuration",
  "z_graph_write_fence:user":
    "graph-write fence check (plain reads); the user delete holds the owner fences",
};

/**
 * Tables with an owner `userId` column that is NOT a foreign key: the cascade
 * never reaches them, so each must be drained (USER_PLAIN_ID_HISTORY_TABLES)
 * or listed here with the reason a user delete may leave the rows.
 */
const PLAIN_USER_ID_EXEMPT: Record<string, string> = {
  node_enrollment_use: "cascades with its enrollment code (node_enrollment_code → user)",
};

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

  it("drains node and account audit by their userId column", () => {
    for (const table of ["node_audit_event", "audit_event"] as const) {
      expect(USER_PLAIN_ID_HISTORY_TABLES[table].userColumn).toBe("userId");
      expect(plainUserIdTables()).toContainEqual({ table, column: "userId" });
    }
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
      .filter((table) => !history.has(table) && !(table in GRAPH_TABLES))
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
      node: [{ id: "node-1" }],
      runtime: [{ id: "runtime-1" }],
      runtimeModel: [{ id: "model-1" }],
      runtimeInstance: [{ id: "instance-1" }],
      runtimeShare: [{ id: "runtime-share-1" }],
      executionTarget: [{ id: "target-1" }],
      profile: [{ id: "profile-1" }],
      pool: [{ id: "pool-1" }],
      poolMember: [{ id: "member-1" }],
      share: [{ id: "share-1" }],
      apiKey: [{ id: "key-1" }],
      providerAccount: [{ id: "provider-account-1" }],
      providerModel: [{ id: "provider-model-1" }],
    };
    const db = Object.fromEntries(
      Object.entries(rows).map(([delegate, list]) => [delegate, { findMany: async () => list }]),
    );
    const none: Record<DeletedParentTable, string[]> = {
      user: [],
      node: [],
      runtime: [],
      runtime_model: [],
      runtime_instance: [],
      runtime_share: [],
      execution_target: [],
      profile: [],
      pool: [],
      pool_member: [],
      share: [],
      api_key: [],
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
          node: ["node-1"],
          runtime: ["runtime-1"],
          runtime_model: ["model-1"],
          runtime_instance: ["instance-1"],
          runtime_share: ["runtime-share-1"],
          execution_target: ["target-1"],
          profile: ["profile-1"],
          pool: ["pool-1"],
          pool_member: ["member-1"],
          share: ["share-1"],
          api_key: ["key-1"],
          provider_account: ["provider-account-1"],
          provider_model: ["provider-model-1"],
        },
      },
      {
        label: "node (its always-on runtimes go with it)",
        scope: { userId: "u", nodeIds: ["n"] },
        expected: {
          ...none,
          node: ["n"],
          runtime: ["runtime-1"],
          runtime_model: ["model-1"],
          runtime_instance: ["instance-1"],
          runtime_share: ["runtime-share-1"],
          execution_target: ["target-1"],
          pool_member: ["member-1"],
        },
      },
      {
        label: "pool",
        scope: { userId: "u", poolIds: ["p"] },
        expected: { ...none, pool: ["p"], share: ["share-1"], pool_member: ["member-1"] },
      },
      {
        label: "share (its contributed members go)",
        scope: { userId: "u", shareIds: ["s"] },
        expected: { ...none, share: ["s"], pool_member: ["member-1"] },
      },
      {
        label: "instance",
        scope: { userId: "u", instanceIds: ["i"] },
        expected: { ...none, runtime_instance: ["i"], execution_target: ["target-1"] },
      },
      {
        label: "provider account",
        scope: { userId: "u", providerAccountIds: ["a"] },
        expected: {
          ...none,
          provider_account: ["a"],
          provider_model: ["provider-model-1"],
          execution_target: ["target-1"],
          pool_member: ["member-1"],
        },
      },
      {
        label: "api key",
        scope: { userId: "u", apiKeyIds: ["k"] },
        expected: { ...none, api_key: ["k"] },
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

  it("handles every NoAction/RESTRICT edge inside the deleted graph", () => {
    const restrict = edges
      .filter(
        (edge) =>
          (edge.action === "Restrict" || edge.action === "NoAction") && reach.has(edge.parent),
      )
      .map((edge) => `${edge.child}.${edge.column}`)
      .sort();
    expect(Object.keys(DELETE_ORDER_EDGES).sort()).toEqual(restrict);
  });
});
