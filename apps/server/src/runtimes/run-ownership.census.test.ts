import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Run ownership (packages/api/src/lib/instance-run.ts), census layer (T20). The guarantee that a
// step of an earlier run never acts on its successor rests on two enforced layers: SQL (the
// `instance_run_order` triggers and the graph-write fences on `runGeneration` / `generation`)
// and the gates inside the boundary functions (each fault-replayed by
// lifecycle-run-ownership.test.ts). This file is the third layer: a reviewed regression
// tripwire over the syntax tree of every production source (`@babel/parser`, a declared root
// dev dependency). It is FAIL-CLOSED: every site of these kinds must be on the reviewed list
// below with a reason, and anything new, removed, changed or unreadable fails until reviewed:
// - every write to a run table (create, update, upsert and delete, of any call shape: comments,
//   line breaks and generic arguments do not hide one), with the watched keys its `data` /
//   `create` / `update` writes at any depth, `other` when it writes none of them (still listed),
//   `opaque` when they cannot be read (a spread, a computed key, an identifier as data), or
//   `delete`;
// - every nested write into a run table from another delegate's write, through ANY relation
//   field the Prisma schema declares to a run model (read from the schema files, not a list);
// - every raw SQL call ($queryRaw, $executeRaw and their Unsafe forms, called or tagged, with
//   or without generic arguments): `raw` when its text (as executed: escapes decoded) names a
//   run table, `raw-other` when it names none, `opaque` when the text is not a literal at the
//   call (a query built elsewhere, a variable);
// - every SQL fragment built outside a raw call (`Prisma.sql`, `Prisma.raw`): `fragment` /
//   `fragment-other` the same way, `opaque` for `Prisma.raw` of a non-literal;
// - every dynamic or aliased access that could reach a run table unseen: a computed delegate
//   (`tx[name].update`, `db[name].findMany`) and a run delegate used as a value or destructured
//   (`const steps = tx.instanceStep`), `alias`;
// and compares them with the reviewed census below. It also checks the boundary functions still
// call their gates, pins the run-state consumers anywhere in the server, and checks that every
// batched sweep of the engine reaches every row (`./sweep.ts`). A new, removed or changed entry
// fails until it is reviewed. It is a tripwire, not a proof: layers 1 and 2 carry the guarantee.

type Node = { type: string; start?: number | null; end?: number | null; [key: string]: unknown };
const { parse } = (await import("@babel/parser")) as unknown as {
  parse: (code: string, options: Record<string, unknown>) => Node;
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");
const ROOTS = ["apps/server/src", "packages/api/src", "packages/db/src", "packages/auth/src"];
const WRITES = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);
const RUN_DELEGATES = new Set([
  "runtimeInstance",
  "instanceRank",
  "instanceStep",
  "instanceReservation",
]);
/** The run models (Prisma schema names) and their tables. */
const RUN_MODELS = new Set([
  "RuntimeInstance",
  "InstanceRank",
  "InstanceStep",
  "InstanceReservation",
]);
const READS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Every relation field the schema declares to a run model (`Ranks InstanceRank[]`, `Instance
 * RuntimeInstance?`, ...): another delegate's write reaches a run table through any of them.
 */
function runRelations(): Set<string> {
  const directory = join(repoRoot, "packages/db/prisma/schema");
  const names = new Set<string>();
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".prisma")))
    for (const line of readFileSync(join(directory, file), "utf8").split("\n")) {
      const match = /^\s+([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?\??(\s|$)/.exec(line);
      if (match?.[1] && match[2] && RUN_MODELS.has(match[2])) names.add(match[1]);
    }
  return names;
}
const RUN_RELATIONS = runRelations();
const WATCHED = new Set(["runGeneration", "generation", "claim", "phase"]);
const RAW = new Set(["$executeRaw", "$executeRawUnsafe", "$queryRaw", "$queryRawUnsafe"]);
const RUN_TABLES =
  /\b(?:runtime_instance|instance_rank|instance_step|instance_reservation|RuntimeInstance|InstanceRank|InstanceStep|InstanceReservation)\b/i;

type Entry = { file: string; fn: string; call: string; keys: string };

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "generated", "e2e"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !/(?:\.test-helper|-test-helpers)\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

/** Every node of the tree, with its ancestors (nearest last). */
function* walk(node: Node, ancestors: Node[] = []): Generator<[Node, Node[]]> {
  yield [node, ancestors];
  const next = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) yield* walk(child, next);
    } else if (isNode(value)) yield* walk(value, next);
  }
}

function nameOf(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "PrivateName") return nameOf(node.id);
  if (node.type === "StringLiteral") return String(node.value);
  return null;
}

const FUNCTIONS = new Set([
  "FunctionExpression",
  "FunctionDeclaration",
  "ClassMethod",
  "ClassPrivateMethod",
  "ObjectMethod",
]);

/** The function a node is in: its method or declared function, else its procedure or const. */
function enclosing(ancestors: Node[]): string {
  const nearest = [...ancestors].reverse();
  for (const node of nearest)
    if (FUNCTIONS.has(node.type) && node.type !== "FunctionExpression")
      return nameOf(node.key ?? node.id) ?? "<anonymous>";
  for (const node of nearest) {
    if (
      node.type === "VariableDeclarator" &&
      isNode(node.init) &&
      (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
    )
      return nameOf(node.id) ?? "<const>";
    if (
      node.type === "ObjectProperty" &&
      isNode(node.value) &&
      node.value.type === "CallExpression"
    )
      return nameOf(node.key) ?? "<property>";
  }
  return "<module>";
}

/**
 * The member chain of a callee (`tx.instanceStep.update` → ["tx", "instanceStep", "update"]): a
 * computed member is null, any other expression (a call's result, `this`) is "<expr>".
 */
function chain(node: unknown): Array<string | null> {
  if (!isNode(node)) return ["<expr>"];
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression")
    return [
      ...chain(node.object),
      node.computed && node.property && (node.property as Node).type !== "StringLiteral"
        ? null
        : nameOf(node.property),
    ];
  if (node.type === "TSNonNullExpression" || node.type === "TSAsExpression")
    return chain(node.expression);
  if (node.type === "ThisExpression") return ["this"];
  return [nameOf(node) ?? "<expr>"];
}

/** The watched keys a written value names at any depth (sorted), `opaque`, or null. */
function writtenKeys(value: unknown): string | null {
  if (!isNode(value)) return "opaque";
  if (!["ObjectExpression", "ArrayExpression", "ConditionalExpression"].includes(value.type))
    return "opaque";
  const keys = new Set<string>();
  let opaque = false;
  const visit = (node: Node) => {
    if (node.type === "ObjectExpression") {
      for (const property of node.properties as Node[]) {
        if (property.type === "SpreadElement") {
          // A spread of a conditional between literals is still readable.
          const argument = property.argument as Node;
          if (
            argument.type === "ConditionalExpression" &&
            (argument.consequent as Node).type === "ObjectExpression" &&
            (argument.alternate as Node).type === "ObjectExpression"
          ) {
            visit(argument.consequent as Node);
            visit(argument.alternate as Node);
          } else opaque = true;
          continue;
        }
        if (property.computed) {
          opaque = true;
          continue;
        }
        const key = nameOf(property.key);
        if (key && WATCHED.has(key)) keys.add(key);
        if (isNode(property.value)) visit(property.value);
      }
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements as unknown[]) if (isNode(element)) visit(element);
      return;
    }
    if (node.type === "ConditionalExpression") {
      visit(node.consequent as Node);
      visit(node.alternate as Node);
    }
    // Any other value (an identifier, a call) is a column's value: its key was read above.
  };
  visit(value);
  if (opaque) return "opaque";
  return keys.size > 0 ? [...keys].sort().join(",") : null;
}

/** The written part of a write's argument (`data`, `create`, `update`), or opaque. */
function argumentKeys(argument: unknown): string | null {
  if (!isNode(argument) || argument.type !== "ObjectExpression") return "opaque";
  const keys = new Set<string>();
  for (const property of argument.properties as Node[]) {
    if (property.type === "SpreadElement" || property.computed) return "opaque";
    const key = nameOf(property.key);
    if (key !== "data" && key !== "create" && key !== "update") continue;
    if (property.shorthand) return "opaque";
    const found = writtenKeys(property.value);
    if (found === "opaque") return "opaque";
    for (const name of found?.split(",") ?? []) keys.add(name);
  }
  return keys.size > 0 ? [...keys].sort().join(",") : null;
}

/**
 * Whether a write's argument writes through a run relation: a relation field to a run model
 * inside its written part (`data`, `create`, `update`), at any depth (filters in `where` only
 * read). An argument that is not an object literal cannot be read: opaque.
 */
function writesRunRelation(argument: unknown): boolean | "opaque" {
  if (!isNode(argument) || argument.type !== "ObjectExpression") return "opaque";
  for (const property of argument.properties as Node[]) {
    if (property.type === "SpreadElement" || property.computed) return "opaque";
    const key = nameOf(property.key);
    if (key !== "data" && key !== "create" && key !== "update") continue;
    if (!isNode(property.value) || property.shorthand) return "opaque";
    for (const [node] of walk(property.value))
      if (node.type === "ObjectProperty" && RUN_RELATIONS.has(nameOf(node.key) ?? "")) return true;
  }
  return false;
}

function rawText(source: string, node: Node): string {
  return source.slice(node.start ?? 0, node.end ?? 0);
}

function tree(file: string, source: string): Node {
  return parse(source, {
    sourceType: "module",
    plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"],
  });
}

/**
 * The SQL text of a literal as it runs (escapes decoded: Babel's string value and a template's
 * cooked parts, never the source spelling), or null when it is not a literal. A template with
 * interpolations is read by its literal parts: a tagged raw call sends each interpolation as a
 * parameter, and a fragment interpolated into it (`Prisma.sql`) is listed where it is built.
 */
function sqlText(node: unknown, allowInterpolation: boolean): string | null {
  if (!isNode(node)) return null;
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "TemplateLiteral") {
    const expressions = (node.expressions as unknown[]) ?? [];
    if (expressions.length > 0 && !allowInterpolation) return null;
    return (node.quasis as Node[])
      .map((quasi) => String((quasi.value as { cooked?: string | null }).cooked ?? ""))
      .join(" ");
  }
  return null;
}

/** `raw` / `raw-other` (or `fragment` / `fragment-other`) by whether the text names a run table. */
function sqlClass(text: string, kind: "raw" | "fragment"): string {
  return RUN_TABLES.test(text) ? kind : `${kind}-other`;
}

/** Every census entry of one source file. */
function scan(file: string, source: string): Entry[] {
  const entries: Entry[] = [];
  for (const [node, ancestors] of walk(tree(file, source))) {
    const at = () => enclosing(ancestors);
    const parent = ancestors.at(-1);
    if (node.type === "TaggedTemplateExpression") {
      const tag = chain(node.tag);
      const method = tag.at(-1);
      const text = sqlText(node.quasi, true) ?? "";
      if (method && RAW.has(method))
        entries.push({ file, fn: at(), call: method, keys: sqlClass(text, "raw") });
      else if (method === "sql" && tag.at(-2) === "Prisma")
        entries.push({ file, fn: at(), call: "Prisma.sql", keys: sqlClass(text, "fragment") });
      continue;
    }
    // A run delegate used as a value (aliased, passed, returned) or destructured: what it is
    // used for cannot be read here.
    if (
      (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") &&
      !node.computed &&
      RUN_DELEGATES.has(nameOf(node.property) ?? "")
    ) {
      const usedAsObject =
        isNode(parent) &&
        (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
        parent.object === node;
      if (!usedAsObject)
        entries.push({ file, fn: at(), call: `${nameOf(node.property)}`, keys: "alias" });
      continue;
    }
    if (node.type === "ObjectPattern") {
      for (const property of node.properties as Node[])
        if (property.type === "ObjectProperty" && RUN_DELEGATES.has(nameOf(property.key) ?? ""))
          entries.push({ file, fn: at(), call: `${nameOf(property.key)}`, keys: "alias" });
      continue;
    }
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") continue;
    const names = chain(node.callee);
    const method = names.at(-1) ?? null;
    const args = (node.arguments as unknown[]) ?? [];
    if (method && RAW.has(method)) {
      const text = sqlText(args[0], false);
      entries.push({
        file,
        fn: at(),
        call: method,
        keys: text === null ? "opaque" : sqlClass(text, "raw"),
      });
      continue;
    }
    if (method === "raw" && names.at(-2) === "Prisma") {
      const text = sqlText(args[0], false);
      entries.push({
        file,
        fn: at(),
        call: "Prisma.raw",
        keys: text === null ? "opaque" : sqlClass(text, "fragment"),
      });
      continue;
    }
    if (!method || (!WRITES.has(method) && !READS.has(method)) || names.length < 2) continue;
    const delegate = names.at(-2);
    if (delegate === null) {
      // `db[name].update(...)`, `db[name].findMany(...)`: which table it reaches cannot be read.
      entries.push({ file, fn: at(), call: `[computed].${method}`, keys: "opaque" });
      continue;
    }
    if (!WRITES.has(method) || !delegate || delegate === "<expr>") continue;
    if (RUN_DELEGATES.has(delegate)) {
      const keys = method.startsWith("delete") ? "delete" : (argumentKeys(args[0]) ?? "other");
      entries.push({ file, fn: at(), call: `${delegate}.${method}`, keys });
      continue;
    }
    // Another delegate's write that creates or changes run rows through a relation.
    const nested = writesRunRelation(args[0]);
    if (nested === true)
      entries.push({ file, fn: at(), call: `${delegate}.${method}`, keys: "nested" });
  }
  return entries;
}

/** The functions calling `name(` (a bare or a member call) in one source. */
function callers(file: string, source: string, name: string): string[] {
  const found = new Set<string>();
  for (const [node, ancestors] of walk(tree(file, source)))
    if (
      (node.type === "CallExpression" || node.type === "OptionalCallExpression") &&
      chain(node.callee).at(-1) === name
    )
      found.add(enclosing(ancestors));
  return [...found];
}

/**
 * The reviewed census: `file | function | call | keys` → [how many, why it is allowed]. Every
 * run-table write (`other` included), nested run write, raw call or fragment naming a run
 * table, unreadable (`opaque`) SQL and dynamic access is listed here; anything not listed fails. Watched keys: `runGeneration` (written only by instance-run.ts, and as run 1 of a new
 * instance), `generation` (steps are created only at the current run), `claim` (the release and
 * retake boundaries, mark-stopped, the drain), `phase` (a run-starting writer begins a run;
 * same-run recovery is a named exemption). `delete`: rows removed (launch and stop evidence of a
 * run is never deleted while its instance exists: HEALTH pruning, reservation rows and whole
 * instances only).
 */
const LC = "apps/server/src/runtimes/lifecycle.ts";
const AO = "apps/server/src/runtimes/always-on.ts";
const RS = "packages/api/src/lib/reservations.ts";
const SM = "apps/server/src/relay/session-manager.ts";
const DB = "packages/db/src";
const CENSUS: Record<string, [number, string]> = {
  "apps/server/src/model-api/cache-affinity-generation.ts | instanceByHandleSql | Prisma.sql | fragment":
    [1, "Reads an instance id by node and handle (SELECT only)."],
  "apps/server/src/model-api/cache-affinity-generation.ts | persistAffinityCounterEpoch | Prisma.sql | fragment":
    [
      1,
      'UPDATE runtime_instance "loadCounterEpoch" (cache-affinity metadata): no run, phase, claim or step.',
    ],
  "apps/server/src/model-api/cache-affinity-generation.ts | readAffinityCounterEpoch | Prisma.sql | fragment":
    [1, 'Reads runtime_instance "loadCounterEpoch" (SELECT only).'],
  "apps/server/src/model-api/cache-affinity-generation.ts | resetAffinityForCapacities | Prisma.sql | fragment":
    [
      1,
      'UPDATE runtime_instance "cacheGeneration" (cache-affinity metadata): no run, phase, claim or step.',
    ],
  "apps/server/src/model-api/cache-affinity-maintenance.ts | startAffinityAuthorityMaintenance | $executeRaw | raw":
    [
      1,
      "Cache-affinity metadata keyed by instance (NOT EXISTS reads); never a run, claim or step.",
    ],
  "apps/server/src/model-api/cache-affinity-observers.ts | discoverAffinityObservers | Prisma.sql | fragment":
    [
      1,
      "Reads instances and ranks to find affinity observers (SELECT only; writes cache_affinity_observer).",
    ],
  "apps/server/src/model-api/cache-affinity-observers.ts | headedByNodeSql | Prisma.sql | fragment":
    [1, "Reads the instances a node heads (SELECT only)."],
  "apps/server/src/model-api/cache-affinity-observers.ts | observeAffinityReset | Prisma.sql | fragment":
    [1, "Reads runtime_instance to scope an observer reset (writes cache_affinity_observer only)."],
  "apps/server/src/model-api/cache-affinity-residency.ts | affinityGenerationReadySql | Prisma.sql | fragment":
    [1, "Reads runtime_instance's cache generation (SELECT only)."],
  "apps/server/src/model-api/cache-affinity-residency.ts | queryAffinityResidency | $queryRaw | opaque":
    [
      1,
      "The cache-affinity executor: runs the fragments listed above (cache-affinity-generation/-observers/-residency); each is listed where it is built.",
    ],
  "apps/server/src/model-api/cache-affinity.ts | rankAffinityTargets | $queryRaw | opaque": [
    1,
    "Composed of cache-affinity.ts fragments (all listed fragment-other: affinity tables).",
  ],
  "apps/server/src/model-api/cache-affinity.ts | rememberAffinity | $executeRaw | opaque": [
    4,
    "Composed of cache-affinity.ts fragments (affinity record/node tables).",
  ],
  "apps/server/src/model-api/cache-affinity.ts | rememberAffinity | $queryRaw | opaque": [
    2,
    "Composed of cache-affinity.ts fragments (affinity tables).",
  ],
  "apps/server/src/model-api/cache-affinity.ts | resolveAffinitySession | $queryRaw | opaque": [
    1,
    "Composed of cache-affinity.ts fragments (affinity tables).",
  ],
  "apps/server/src/model-api/capacity/postgres-store.ts | sweepOrphans | $queryRaw | raw": [
    1,
    "Read-only orphan sweep of capacity leases (reads instances, writes none of their rows).",
  ],
  "apps/server/src/model-api/kv-eviction-feedback.ts | resetKvEvictionForInstance | Prisma.sql | fragment":
    [1, "Reads runtime_instance to scope a capacity_kv_eviction reset (writes that table only)."],
  "apps/server/src/model-api/local-send.ts | checkPermission | $queryRaw | raw": [
    1,
    "Read-only admission check (FOR SHARE): never writes a run, claim or step.",
  ],
  "apps/server/src/model-api/usage-rollup.ts | additive | Prisma.raw | opaque": [
    1,
    "A rollup column name from the fixed usage-rollup column lists.",
  ],
  "apps/server/src/model-api/usage-rollup.ts | histogramMerge | Prisma.raw | opaque": [
    1,
    "A histogram column name from the fixed usage-rollup lists.",
  ],
  "apps/server/src/model-api/usage-rollup.ts | rollupUpsertSql | Prisma.raw | opaque": [
    4,
    "usage_rollup_minute/hour table and column names from fixed lists.",
  ],
  "apps/server/src/model-api/usage-rollup.ts | writeRollupIncrements | $executeRaw | opaque": [
    1,
    "Runs rollupUpsertSql (usage rollup tables).",
  ],
  "apps/server/src/model-api/warm-protection.ts | authorizedKvEvictionRows | $queryRaw | opaque": [
    1,
    "Composed of warm-protection.ts fragments (read-only: affinity, leases, pools).",
  ],
  "apps/server/src/model-api/warm-protection.ts | loadWarmSessions | $queryRaw | opaque": [
    1,
    "Composed of warm-protection.ts fragments (read-only).",
  ],
  "apps/server/src/relay/node-metrics-rollup.ts | writeNodeMetricsIncrements | $executeRaw | opaque":
    [2, "node_metrics_minute upserts built in this file."],
  "apps/server/src/relay/runtime-load-rollup.ts | nullableMax | Prisma.raw | opaque": [
    1,
    "A runtime_load_minute column name (fixed).",
  ],
  "apps/server/src/relay/runtime-load-rollup.ts | writeRuntimeLoadIncrements | $executeRaw | opaque":
    [1, "runtime_load_minute upsert built in this file."],
  [`${AO} | observeInstance | runtimeInstance.create | phase`]: [
    1,
    "Always-on instance: no run, ranks or steps.",
  ],
  [`${AO} | observeInstance | runtimeInstance.update | opaque`]: [1, "Always-on status (no run)."],
  [`${AO} | observeInstance | runtimeInstance.update | phase`]: [1, "Always-on status (no run)."],
  [`${AO} | removeUnreported | runtimeInstance.deleteMany | delete`]: [
    1,
    "An always-on instance the node no longer reports (no run, ranks or steps).",
  ],
  [`${AO} | removeUnreported | runtimeInstance.updateMany | phase`]: [
    1,
    "Always-on status (no run).",
  ],
  [`${AO} | upsertNodeOrigin | runtimeInstance.create | phase`]: [1, "Always-on instance: no run."],
  [`${AO} | upsertNodeOrigin | runtimeInstance.updateMany | other`]: [
    1,
    "Always-on instance's versions (no run).",
  ],
  [`${LC} | afterStep | runtimeInstance.update | phase`]: [
    1,
    "READY after this run's READINESS (gated: `owned` returns first for an earlier run's step).",
  ],
  [`${LC} | applyJobResult | instanceStep.updateMany | opaque`]: [
    1,
    "Physical bookkeeping of the answered step (retry to PENDING); effects go through afterStep's gate.",
  ],
  [`${LC} | applyJobResult | instanceStep.updateMany | other`]: [
    1,
    "The answered step's own result (state, error, deadline); effects on the run go through afterStep's `owned` gate.",
  ],
  [`${LC} | cancelStep | instanceStep.updateMany | other`]: [
    1,
    "A person cancels a step that waits for them (FAILED operator_cancelled); never an accepted run.",
  ],
  [`${LC} | claimStep | instanceRank.updateMany | other`]: [
    1,
    "The rank's blockedBy list (what its start waits for); no claim state.",
  ],
  [`${LC} | claimStep | instanceStep.updateMany | other`]: [
    3,
    "Claiming a step after claimStep's gates (lease, attempt, terminal), or settling an earlier run's step (`owned` false).",
  ],
  [`${LC} | clearOperatorHold | instanceStep.updateMany | other`]: [
    1,
    "Clears a step's operator hold (and its hold error code).",
  ],
  [`${LC} | closeOperatorKeepingRun | instanceStep.updateMany | other`]: [
    1,
    "R5-B-1: records a person's acceptance the relay saw but the database missed (RUNNING, accepted, deadline); the step only.",
  ],
  [`${LC} | createGeneration | instanceStep.updateMany | other`]: [
    1,
    "Ends the previous generation's open steps of this run (state), in the run's own writer.",
  ],
  [`${LC} | createGeneration | runtimeInstance.update | other`]: [
    1,
    "Resets health counters and the cache generation for the new generation; no run, phase or claim.",
  ],
  [`${LC} | drainInstance | instanceRank.updateMany | claim`]: [
    1,
    "Named exemption: an inactive owner's unanswerable stop marks HELD_UNKNOWN (current state, never a release).",
  ],
  [`${LC} | drainInstance | instanceStep.updateMany | other`]: [
    1,
    "An inactive owner's waiting steps end (FAILED owner_inactive); a person's run is left alone.",
  ],
  [`${LC} | expireSteps | instanceStep.updateMany | other`]: [
    1,
    "A step past its deadline fails (job_deadline); a person's accepted run is never expired.",
  ],
  [`${LC} | failStep | instanceStep.updateMany | other`]: [
    1,
    "A step fails (state, error); afterStep's gate decides any effect on the run.",
  ],
  [`${LC} | gangStop | runtimeInstance.update | phase`]: [
    1,
    "STOPPING: ends the current run (no new run).",
  ],
  [`${LC} | insertSteps | instanceStep.create | generation,phase`]: [
    1,
    "The only step creator: asserts generation === the current run (trigger instance_step_run_order backs it).",
  ],
  [`${LC} | operatorClosed | instanceStep.updateMany | other`]: [
    1,
    "The operator terminal closed without success: the step waits for its person again.",
  ],
  [`${LC} | operatorProgress | instanceStep.updateMany | other`]: [
    2,
    "The confirm screen came up (AWAITING_OPERATOR) or its person pressed Enter (RUNNING, accepted).",
  ],
  [`${LC} | probeHeldUnknown | instanceRank.updateMany | other`]: [
    2,
    "Stamp rotation of HELD_UNKNOWN probes (lastStopCheckAt); never the claim.",
  ],
  [`${LC} | pruneHealth | instanceStep.deleteMany | delete`]: [
    1,
    "Finished HEALTH probes past their history (WHERE phase HEALTH): never launch or stop evidence.",
  ],
  [`${LC} | reconcileStopping | runtimeInstance.updateMany | other`]: [
    1,
    "Stamp rotation of the stopping reconcile (lastStopReconcileAt).",
  ],
  [`${LC} | recordHealth | runtimeInstance.update | opaque`]: [
    1,
    "Health of the current run (afterStep gate).",
  ],
  [`${LC} | recordInstanceFacts | runtimeInstance.update | opaque`]: [
    1,
    "Engine facts from a record of the current run (inventoryEvidence gate).",
  ],
  [`${LC} | recordOperatorHold | instanceStep.updateMany | other`]: [
    1,
    "Records why a step is held for its person (operatorHold, error code).",
  ],
  [`${LC} | reissueOperatorStep | instanceStep.updateMany | opaque`]: [
    1,
    "Back to PENDING; claimStep's `owned` gate settles it if its run is over.",
  ],
  [`${LC} | reopenStep | instanceStep.updateMany | opaque`]: [
    1,
    "Refused for an earlier run's step (`owned`).",
  ],
  [`${LC} | requeueLost | instanceStep.updateMany | other`]: [
    1,
    "Same-ID requeue of a step whose session was lost (back to PENDING); claimStep re-gates it.",
  ],
  [`${LC} | restartDue | runtimeInstance.update | other`]: [
    1,
    "Schedules the next automatic restart attempt (nextRestartAt).",
  ],
  [`${LC} | restartDue | runtimeInstance.updateMany | other`]: [
    1,
    "Clears nextRestartAt of rows no longer due.",
  ],
  [`${LC} | retake | instanceRank.update | other`]: [
    1,
    "Inside retakeInstanceClaims's writeRanks: the rank's resources as re-planned (the run was begun first).",
  ],
  [`${LC} | retake | instanceRank.updateMany | opaque`]: [
    1,
    "The automatic restart's retake inside retakeInstanceClaims (begins the run).",
  ],
  [`${LC} | retake | runtimeInstance.update | other`]: [
    1,
    "Retake refused: waiting_<reason> and the 30 s retry; no run, phase or claim.",
  ],
  [`${LC} | retake | runtimeInstance.update | phase`]: [
    2,
    "FAILED (node deleted), or STARTING after retakeInstanceClaims began the run in this transaction.",
  ],
  [`${LC} | runtimeInventory | runtimeInstance.update | other`]: [
    1,
    "Inventory heartbeat (lastHealthAt) after the inventoryEvidence gate.",
  ],
  [`${LC} | settleOperatorSteps | instanceStep.updateMany | other`]: [
    1,
    "Ends steps waiting for their person (CANCELLED/FAILED); a person's run is left alone and recorded (R5-B-1).",
  ],
  [`${LC} | settleStopped | instanceStep.updateMany | other`]: [
    2,
    "The stopped run's waiting steps end (state, error, hold).",
  ],
  [`${LC} | settleStopped | runtimeInstance.update | phase`]: [
    5,
    "STOPPED / FAILED: the run ended (no new run).",
  ],
  [`${LC} | settleStopping | instanceStep.updateMany | other`]: [
    3,
    "Stopping: the run's waiting steps end or carry the stop's error code.",
  ],
  [`${LC} | settleStopping | runtimeInstance.update | other`]: [
    1,
    "needsOperator MARK_STOPPED while a stop cannot be proven (attention only).",
  ],
  [`${LC} | settleSupersededOperator | instanceStep.updateMany | other`]: [
    1,
    "An earlier run's screen ends (FAILED superseded / CANCELLED); nothing for the successor.",
  ],
  [`${LC} | syncNeedsOperator | runtimeInstance.update | other`]: [
    1,
    "needsOperator / needsOperatorSince (attention only; it authorizes nothing).",
  ],
  [`${LC} | undeliver | instanceStep.updateMany | opaque`]: [
    1,
    "The frame never left: back to PENDING.",
  ],
  [`${LC} | watchInstance | runtimeInstance.update | phase`]: [
    2,
    "Named exemption: same-run UNAVAILABLE and recovery (READY only with this run's READINESS); the run is resolved first.",
  ],
  "packages/api/src/lib/claim-release.ts | releaseClaim | instanceRank.updateMany | claim": [
    1,
    "The one TypeScript release: proof bound, owned and fresh, or never-ran, or a person's HELD_UNKNOWN release.",
  ],
  "packages/api/src/lib/engine-facts.ts | applyFactsToInstance | runtimeInstance.updateMany | opaque":
    [1, "Dormant engine-facts helper (no claim, run or step)."],
  "packages/api/src/lib/instance-run.ts | beginRun | runtimeInstance.update | runGeneration": [
    1,
    "The only increment of a run.",
  ],
  "packages/api/src/lib/instance-run.ts | resolveRun | runtimeInstance.updateMany | runGeneration":
    [1, "A legacy row's one-time bootstrap (WHERE runGeneration = 0)."],
  "packages/api/src/lib/metrics-query.ts | bucketExpr | Prisma.raw | opaque": [
    1,
    "A time-bucket expression from fixed step names (read-only metrics).",
  ],
  "packages/api/src/lib/metrics-query.ts | ident | Prisma.raw | opaque": [
    1,
    "A quoted identifier from the metrics plan's fixed names (read-only).",
  ],
  "packages/api/src/lib/metrics-query.ts | nodePlan | Prisma.raw | opaque": [
    1,
    "A node metrics column from fixed lists (read-only).",
  ],
  "packages/api/src/lib/metrics-query.ts | requestAggregates | Prisma.raw | opaque": [
    1,
    "Request aggregate columns from fixed lists (read-only).",
  ],
  "packages/api/src/lib/metrics-query.ts | requestColumns | Prisma.raw | opaque": [
    1,
    "Request columns from fixed lists (read-only).",
  ],
  "packages/api/src/lib/needs-you-mail.ts | sweepNeedsYouMail | runtimeInstance.updateMany | other":
    [3, "Needs-you e-mail bookkeeping (notified at, failures)."],
  "packages/api/src/lib/overview-summary.ts | histogramColumns | Prisma.raw | opaque": [
    3,
    "Histogram columns from fixed lists (read-only overview).",
  ],
  [`${RS} | dropSupersededReservations | instanceReservation.deleteMany | delete`]: [
    1,
    "Superseded rows once a later START was claimed (after the leading STOP proved the old run ended).",
  ],
  [`${RS} | replaceInstanceReservations | instanceReservation.createMany | opaque`]: [
    2,
    "Reservation rows of the run retakeInstanceClaims just began.",
  ],
  [`${RS} | replaceInstanceReservations | instanceReservation.deleteMany | delete`]: [
    2,
    "Plans that never started, or of a run proven stopped: reservation rows only (steps, the launch evidence, are kept).",
  ],
  [`${RS} | replaceInstanceReservations | instanceReservation.update | other`]: [
    1,
    "A kept reservation row's labels (same node and resources) for the run retakeInstanceClaims just began.",
  ],
  [`${RS} | replaceInstanceReservations | instanceReservation.updateMany | other`]: [
    2,
    "Marks a replaced run's rows superseded (supersededGeneration): they keep holding until its STOP is proven.",
  ],
  "packages/api/src/lib/runtime-store.ts | markInstancesStopping | runtimeInstance.updateMany | phase":
    [1, "STOPPING (no new run); the runs were resolved first."],
  "packages/api/src/lib/runtime-store.ts | writePlannedStarts | instanceRank.update | opaque": [
    1,
    "Inside retakeInstanceClaims's writeRanks (the run was begun first).",
  ],
  "packages/api/src/lib/runtime-store.ts | writePlannedStarts | runtimeInstance.create | phase,runGeneration":
    [1, "A new instance at run 1 (its ranks and reservations nested, of that run)."],
  "packages/api/src/lib/runtime-store.ts | writePlannedStarts | runtimeInstance.update | phase": [
    1,
    "STARTING; retakeInstanceClaims begins the run in the same transaction.",
  ],
  "packages/api/src/routers/runtimes.ts | createRuntime | runtimeInstance.create | phase": [
    1,
    "An always-on runtime's instance (no run).",
  ],
  "packages/api/src/routers/runtimes.ts | delete | runtimeInstance.deleteMany | delete": [
    1,
    "Deleting a runtime with nothing running: its instances go with their steps (CASCADE); no run remains.",
  ],
  "packages/api/src/routers/runtimes.ts | markStopped | instanceRank.updateMany | claim": [
    1,
    "Named exemption: a person marks a STOPPING rank HELD_UNKNOWN (never a release).",
  ],
  "packages/api/src/routers/runtimes.ts | markStopped | instanceStep.updateMany | other": [
    1,
    "A person marks a stop: the rank's waiting stop steps end (state, hold).",
  ],
  "packages/api/src/routers/runtimes.ts | update | runtimeInstance.updateMany | other": [
    2,
    "Definition update: instances adopt the new version live (versionId; always-on also launchVersionId).",
  ],
  "packages/api/src/routers/runtimes.ts | update | runtimeInstance.updateMany | phase": [
    1,
    "Definition update restart: STARTING, then beginRun per restarted instance in the same transaction.",
  ],
  [`${DB}/capacity-lock-order.ts | deleteUserGraphInOrder | runtimeInstance.deleteMany | delete`]: [
    1,
    "Account deletion: the whole user graph goes (no run remains to own anything).",
  ],
  [`${DB}/hot-path-sweeps.ts | deleteOwnedBatch | Prisma.raw | opaque`]: [
    5,
    "Table/column of a deleted user's hot-path rows: rollup, telemetry and affinity tables named at the callers (no run table).",
  ],
  [`${DB}/hot-path-sweeps.ts | pruneOrphanCapacityScheduler | $executeRaw | raw`]: [
    1,
    "Deletes capacity_scheduler rows whose instance is gone (reads runtime_instance only).",
  ],
  [`${DB}/hot-path-sweeps.ts | purgeDeletedUserHistory | $executeRaw | opaque`]: [
    1,
    "Deletes a purged user's rows of the fixed affinity/history tables (no run table).",
  ],
  [`${DB}/hot-path-sweeps.ts | purgeDeletedUserHistory | Prisma.raw | opaque`]: [
    4,
    "Table names from fixed affinity lists and USER_PLAIN_ID_HISTORY_TABLES (audit tables).",
  ],
  [`${DB}/hot-path-sweeps.ts | reclaimClearedAffinity | $executeRaw | opaque`]: [
    1,
    "Deletes cleared cache_affinity_record/node rows (fixed list).",
  ],
  [`${DB}/hot-path-sweeps.ts | reclaimClearedAffinity | $queryRaw | opaque`]: [
    1,
    "Reads whether cleared affinity rows remain (fixed list).",
  ],
  [`${DB}/hot-path-sweeps.ts | reclaimClearedAffinity | Prisma.raw | opaque`]: [
    5,
    "cache_affinity_record/node and a fixed comparison operator.",
  ],
  [`${DB}/parent-deletion-residual.ts | edgeFilters | Prisma.raw | opaque`]: [
    1,
    "An alias.column of HISTORY_DRAIN_EDGES (history tables keyed by deleted parents).",
  ],
  [`${DB}/parent-deletion.ts | drainParentDeletionHistory | $executeRaw | opaque`]: [
    1,
    "Drains history rows of deleted parents (cache_affinity_scope/observer, capacity_scheduler, audit tables); run rows go with Prisma cascades.",
  ],
  [`${DB}/parent-deletion.ts | drainParentDeletionHistory | Prisma.raw | opaque`]: [
    5,
    "Table/column names from the fixed drain lists above (no run table).",
  ],
  [`${DB}/usage-rollup-requester-drain.ts | drainTable | $queryRawUnsafe | opaque`]: [
    1,
    "Merges a deleted requester's usage_rollup_minute/hour rows (table typed as those two).",
  ],
};

/**
 * Raw SQL and fragments whose text (as executed) names no run table, per file: `raw-other` /
 * `fragment-other` sites, each file reviewed for the tables it uses. A new file or a changed
 * count fails until reviewed (a site that starts naming a run table moves to CENSUS).
 */
const SQL_ELSEWHERE: Record<string, [number, string]> = {
  "apps/server/src/app.ts | raw-other": [1, "Health check (SELECT 1)."],
  "apps/server/src/index.ts | raw-other": [1, "Startup database check."],
  "apps/server/src/model-api/cache-affinity-maintenance.ts | raw-other": [
    2,
    "Affinity maintenance on affinity tables.",
  ],
  "apps/server/src/model-api/cache-affinity-observers.ts | fragment-other": [
    8,
    "Affinity observer tables (cache_affinity_observer, node).",
  ],
  "apps/server/src/model-api/cache-affinity-residency.ts | fragment-other": [
    3,
    "Affinity residency tables (cache_affinity_residency*, execution_target).",
  ],
  "apps/server/src/model-api/cache-affinity-residency.ts | raw-other": [
    13,
    "Affinity residency tables (cache_affinity_residency*, execution_target).",
  ],
  "apps/server/src/model-api/cache-affinity.ts | fragment-other": [
    24,
    "Affinity record/node tables.",
  ],
  "apps/server/src/model-api/cache-affinity.ts | raw-other": [10, "Affinity record/node tables."],
  "apps/server/src/model-api/capacity/postgres-store.ts | raw-other": [
    16,
    "Capacity leases, waiters and schedulers.",
  ],
  "apps/server/src/model-api/capacity/production-runtime.ts | raw-other": [
    1,
    "Capacity runtime bookkeeping.",
  ],
  "apps/server/src/model-api/kv-eviction-feedback.ts | fragment-other": [
    9,
    "capacity_kv_eviction.",
  ],
  "apps/server/src/model-api/kv-eviction-feedback.ts | raw-other": [1, "capacity_kv_eviction."],
  "apps/server/src/model-api/local-send.ts | raw-other": [
    9,
    "Admission/capacity rows of a local send.",
  ],
  "apps/server/src/model-api/provider-attempt-runtime.ts | raw-other": [
    11,
    "Provider attempts and spend.",
  ],
  "apps/server/src/model-api/provider-budget.ts | raw-other": [2, "Provider budget accounting."],
  "apps/server/src/model-api/provider-targets.ts | raw-other": [3, "Provider targets (read)."],
  "apps/server/src/model-api/public-overflow.ts | raw-other": [10, "Public overflow admission."],
  "apps/server/src/model-api/relay-telemetry-recovery.ts | raw-other": [
    1,
    "Relay telemetry recovery.",
  ],
  "apps/server/src/model-api/routes.ts | raw-other": [2, "Request routing reads."],
  "apps/server/src/model-api/usage-retention.ts | raw-other": [
    13,
    "Usage retention sweeps (usage tables).",
  ],
  "apps/server/src/model-api/usage-rollup.ts | fragment-other": [11, "Usage rollup tables."],
  "apps/server/src/model-api/warm-protection.ts | fragment-other": [
    4,
    "Warm-protection reads (affinity, leases, pools).",
  ],
  "apps/server/src/relay/node-metrics-rollup.ts | fragment-other": [4, "node_metrics_minute."],
  "apps/server/src/relay/runtime-load-rollup.ts | fragment-other": [2, "runtime_load_minute."],
  "packages/api/src/lib/metrics-query.ts | fragment-other": [
    54,
    "Read-only metrics over rollup tables.",
  ],
  "packages/api/src/lib/metrics-query.ts | raw-other": [7, "Read-only metrics over rollup tables."],
  "packages/api/src/lib/overview-summary.ts | fragment-other": [
    2,
    "Read-only overview over rollup tables.",
  ],
  "packages/api/src/lib/overview-summary.ts | raw-other": [
    3,
    "Read-only overview over rollup tables.",
  ],
  "packages/api/src/lib/pool-routing.ts | raw-other": [1, "Pool routing reads."],
  "packages/api/src/lib/test-traffic.ts | fragment-other": [2, "Test traffic over usage tables."],
  "packages/api/src/nodes/enroll-exchange.ts | raw-other": [1, "Node enrollment row lock."],
  "packages/api/src/profiles/procedures.ts | raw-other": [2, "Profile row locks."],
  "packages/db/src/capacity-lock-order.ts | raw-other": [
    12,
    "Graph-fence and capacity locks (user/node/capacity rows), no run table.",
  ],
  "packages/db/src/hot-path-sweeps.ts | fragment-other": [
    6,
    "Hot-path sweeps of affinity, usage, relay and spend tables.",
  ],
  "packages/db/src/hot-path-sweeps.ts | raw-other": [
    24,
    "Hot-path sweeps of affinity, usage, relay and spend tables.",
  ],
  "packages/db/src/parent-deletion-residual.ts | fragment-other": [
    1,
    "Residual-edge filters over history tables.",
  ],
  "packages/db/src/parent-deletion.ts | fragment-other": [
    3,
    "Parent-deletion drains of history tables.",
  ],
  "packages/db/src/parent-deletion.ts | raw-other": [
    26,
    "Parent-deletion drains of history tables.",
  ],
  "packages/db/src/spend.ts | fragment-other": [18, "Spend reservations and settlements."],
  "packages/db/src/spend.ts | raw-other": [4, "Spend reservations and settlements."],
};

/** Each boundary function still calls its gate (removing one fails here and in its replay). */
const GATES: Array<[file: string, fn: string, gate: string]> = [
  [LC, "claimStep", "owned"],
  [LC, "claimStep", "resolveRun"],
  [LC, "claimStep", "settleOperatorSteps"],
  [LC, "afterStep", "owned"],
  [LC, "applyJobResult", "settleSupersededOperator"],
  [LC, "inventoryEvidence", "owned"],
  [LC, "inventoryEvidence", "fresh"],
  [LC, "operatorStepWaiting", "resolveRun"],
  [LC, "operatorStepWaiting", "overdueAcceptedRun"],
  [LC, "watchInstance", "resolveRun"],
  [LC, "prepareStarts", "resolveRun"],
  [LC, "reopenStep", "owned"],
  [LC, "retake", "retakeInstanceClaims"],
  ["packages/api/src/lib/claim-release.ts", "proofHolds", "owned"],
  ["packages/api/src/lib/claim-release.ts", "proofHolds", "fresh"],
  ["packages/api/src/lib/claim-release.ts", "releaseClaim", "proofHolds"],
  ["packages/api/src/lib/claim-release.ts", "releaseClaim", "neverRan"],
  [RS, "retakeInstanceClaims", "beginRun"],
  ["packages/api/src/lib/runtime-store.ts", "writePlannedStarts", "retakeInstanceClaims"],
  ["packages/api/src/lib/runtime-store.ts", "markInstancesStopping", "resolveRun"],
  ["packages/api/src/routers/runtimes.ts", "update", "beginRun"],
  ["packages/api/src/routers/runtimes.ts", "update", "heldClaimsMatch"],
  // R5-B-1: every relay "running" answer about an operator step reconciles a missed acceptance.
  [LC, "settleOperatorSteps", "closeOperatorKeepingRun"],
  [LC, "reissueOperatorStep", "closeOperatorKeepingRun"],
  [LC, "settleSupersededOperator", "closeOperatorKeepingRun"],
  [LC, "cancelStep", "closeOperatorKeepingRun"],
  [LC, "drainInstance", "closeOperatorKeepingRun"],
];

/**
 * Consumers of run state outside the write census, anywhere in the server, pinned to their
 * reviewed sites: who builds a job (claimStep, after its gates), who sends one to a node from the
 * engine (dispatchSteps), who registers execution targets (afterStep, after `owned` and this
 * run's readiness), and who classifies and publishes an inventory (the lifecycle's decision,
 * the relay's ordered publication).
 */
const CONSUMERS: Array<[call: string, sites: string[]]> = [
  ["jobFrame", [`${LC} | claimStep`]],
  ["registerExecutionTargets", [`${LC} | afterStep`]],
  ["runtimeInventory", [`${LC} | handlers`, `${SM} | handleInventoryChunk`]],
  ["inventoryEvidence", [`${LC} | runtimeInventory`]],
  // Who applies a node's job result (the engine's handler table only), and who recomputes a
  // person's attention (each after its own step write; the need authorizes nothing).
  ["handleJobResult", [`${LC} | handlers`]],
  [
    "syncNeedsOperator",
    [
      `${LC} | applyJobResult`,
      `${LC} | cancelStep`,
      `${LC} | claimStep`,
      `${LC} | clearOperatorHold`,
      `${LC} | closeOperatorKeepingRun`,
      `${LC} | drainInstance`,
      `${LC} | expireSteps`,
      `${LC} | operatorClosed`,
      `${LC} | operatorProgress`,
      `${LC} | recordOperatorHold`,
      `${LC} | reissueOperatorStep`,
      `${LC} | reopenStep`,
      `${LC} | settleOperatorSteps`,
      `${LC} | settleSupersededOperator`,
    ],
  ],
  // The engine asks the relay about an operator step only through the reconciling helper (the
  // wiring passes the relay's method through).
  [
    "closeOperatorStep",
    ["apps/server/src/relay/node-wiring.ts | <module>", `${LC} | closeOperatorKeepingRun`],
  ],
];

const key = (entry: Entry) => `${entry.file} | ${entry.fn} | ${entry.call} | ${entry.keys}`;
const read = (file: string) => readFileSync(join(repoRoot, file), "utf8");
const files = () =>
  ROOTS.flatMap((root) =>
    sourceFiles(join(repoRoot, root)).map((path) => relative(repoRoot, path)),
  );

function census(): Entry[] {
  return files().flatMap((file) => scan(file, read(file)));
}

function callSites(name: string, under = "apps/server/src/"): string[] {
  return files()
    .filter((file) => file.startsWith(under))
    .flatMap((file) => {
      const source = read(file);
      return source.includes(name)
        ? callers(file, source, name).map((fn) => `${file} | ${fn}`)
        : [];
    })
    .sort();
}

/**
 * Every `take` of the engine's production files: a SweepCursor page (`take: page.take`) or a
 * function marked `// sweep: stamp rotation` (./sweep.ts). Returns the offending sites.
 */
function unboundSweeps(file: string, source: string): string[] {
  const bad: string[] = [];
  for (const [node, ancestors] of walk(tree(file, source))) {
    if (node.type !== "ObjectProperty" || nameOf(node.key) !== "take") continue;
    if (chain(node.value).join(".") === "page.take") continue;
    const fn = [...ancestors]
      .reverse()
      .find((ancestor) => FUNCTIONS.has(ancestor.type) && ancestor.type !== "FunctionExpression");
    if (fn && rawText(source, fn).includes("// sweep: stamp rotation")) continue;
    bad.push(`${file} | ${enclosing(ancestors)}`);
  }
  return bad;
}

describe("run ownership census (T20, a reviewed tripwire)", { timeout: 60_000 }, () => {
  it("lists every run-table write, nested write, raw SQL call, fragment and dynamic access (fail-closed)", () => {
    const counts = new Map<string, number>();
    const elsewhere = new Map<string, number>();
    for (const entry of census()) {
      if (entry.keys === "raw-other" || entry.keys === "fragment-other") {
        const name = `${entry.file} | ${entry.keys}`;
        elsewhere.set(name, (elsewhere.get(name) ?? 0) + 1);
      } else counts.set(key(entry), (counts.get(key(entry)) ?? 0) + 1);
    }
    const reviewed = (list: Record<string, [number, string]>) =>
      Object.fromEntries(
        Object.entries(list)
          .map(([name, [count]]) => [name, count] as const)
          .sort(),
      );
    expect(Object.fromEntries([...counts].sort())).toEqual(reviewed(CENSUS));
    expect(Object.fromEntries([...elsewhere].sort())).toEqual(reviewed(SQL_ELSEWHERE));
    // Every entry says why it is allowed.
    for (const [name, [, why]] of [...Object.entries(CENSUS), ...Object.entries(SQL_ELSEWHERE)])
      expect([name, why.trim().length > 0]).toEqual([name, true]);
  });

  it("reads the run relations from the schema (not a fixed list)", () => {
    for (const relation of [
      "Instances",
      "LaunchInstances",
      "Ranks",
      "Steps",
      "Reservations",
      "Instance",
    ])
      expect([relation, RUN_RELATIONS.has(relation)]).toEqual([relation, true]);
  });

  it("finds each boundary function's gate", () => {
    for (const [file, fn, gate] of GATES)
      expect(`${fn} → ${gate}: ${callers(file, read(file), gate).includes(fn)}`).toBe(
        `${fn} → ${gate}: true`,
      );
  });

  it("pins the run-state consumers anywhere in the server", () => {
    for (const [call, sites] of CONSUMERS)
      expect([call, callSites(call)]).toEqual([call, [...sites].sort()]);
    // A runtime job goes to a node only from dispatchSteps (after claimStep's gates).
    expect(callSites("sendToNode", "apps/server/src/runtimes/")).toEqual([`${LC} | dispatchSteps`]);
  });

  it("every batched sweep of the engine reaches every row (SweepCursor or stamp rotation)", () => {
    // The cursor itself (sweep.ts) defines the page's take.
    const engine = files().filter(
      (file) =>
        file.startsWith("apps/server/src/runtimes/") &&
        file !== "apps/server/src/runtimes/sweep.ts",
    );
    expect(engine.flatMap((file) => unboundSweeps(file, read(file)))).toEqual([]);
  });

  it("negative fixtures: every write shape is seen; a removed gate and a fixed prefix fail", () => {
    const at = (source: string) => scan("fixture.ts", source).map((entry) => entry.keys);
    const calls = (source: string) => scan("fixture.ts", source).map((entry) => entry.call);
    // DCR-REG: the three bypass strings a lexical key search missed.
    expect(
      at(
        "function f(db) {\n  const runGeneration = 9;\n  return db.runtimeInstance.update({ where: { id }, data: { runGeneration } });\n}",
      ),
    ).toEqual(["runGeneration"]);
    expect(
      at(
        'function f(tx) {\n  const phase = "STARTING";\n  return tx.runtimeInstance.update({ where: { id }, data: { phase } });\n}',
      ),
    ).toEqual(["phase"]);
    expect(
      at(
        'function f(tx) {\n  const claim = "RELEASED";\n  return tx.instanceRank.updateMany({ where: { id }, data: { claim } });\n}',
      ),
    ).toEqual(["claim"]);
    // A spread, a computed key, an identifier as data: opaque (reviewed).
    expect(at("tx.instanceRank.updateMany({ where: {}, data: { ...next } })")).toEqual(["opaque"]);
    expect(
      at('tx.instanceStep.updateMany({ where: {}, data: { ["gen" + "eration"]: 3 } })'),
    ).toEqual(["opaque"]);
    expect(at("tx.runtimeInstance.update({ where: {}, data })")).toEqual(["opaque"]);
    expect(at("tx.runtimeInstance.update({ where: {}, data: payload })")).toEqual(["opaque"]);
    // Quoted keys (the argument's and the data's) and a conditional of literals are read.
    expect(at('tx.runtimeInstance.update({ "data": { "runGeneration": 2 } })')).toEqual([
      "runGeneration",
    ]);
    expect(
      at("tx.instanceStep.updateMany({ data: a ? { state: 1 } : { generation: 2 } })"),
    ).toEqual(["generation"]);
    // A nested relation write inside the data.
    expect(
      at(
        "tx.runtimeInstance.update({ data: { Ranks: { updateMany: { where: {}, data: { claim: 'HELD' } } } } })",
      ),
    ).toEqual(["claim"]);
    // A delete of run evidence (A4-C1), comments between delegate and method, generic raw SQL.
    expect(at("tx.instanceStep.deleteMany({ where: { instanceId } })")).toEqual(["delete"]);
    expect(at("tx.instanceStep /* why */ .deleteMany({ where: {} })")).toEqual(["delete"]);
    expect(at("tx.instanceRank\n  // note\n  .updateMany({ data: { claim: x } })")).toEqual([
      "claim",
    ]);
    expect(
      at(
        "async function f(tx) { await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM instance_step`; }",
      ),
    ).toEqual(["raw"]);
    expect(at("tx.$executeRawUnsafe(text, id)")).toEqual(["opaque"]);
    expect(
      at(
        "async function f(tx) {\n  const q = Prisma.sql`DELETE FROM instance_step`;\n  await tx.$executeRaw(q);\n}",
      ),
    ).toEqual(["fragment", "opaque"]);
    // DC6 (R5 A/B/C/D): what the earlier census dropped is listed now.
    // Ordinary run-table writes with no watched key (state, attempts, operationId, intent).
    expect(
      at("tx.instanceStep.updateMany({ where: { instanceId }, data: { state: 'SUCCEEDED' } })"),
    ).toEqual(["other"]);
    expect(at("tx.instanceStep.updateMany({ where: {}, data: { attempts: 2 } })")).toEqual([
      "other",
    ]);
    expect(at("tx.runtimeInstance.update({ where: {}, data: { operationId: 'op' } })")).toEqual([
      "other",
    ]);
    expect(at("tx.instanceStep.update({ where: {}, data: { intent: next } })")).toEqual(["other"]);
    // SQL built outside the executing function: a module-level fragment, a helper returning one,
    // and a tagged raw call interpolating one (the fragment is listed where it is built, the
    // executor whose text is not a literal is opaque).
    expect(
      at(
        "const query = Prisma.sql`UPDATE instance_rank SET claim = 'RELEASED'`;\nasync function f(tx) { await tx.$executeRaw(query); }",
      ),
    ).toEqual(["fragment", "opaque"]);
    expect(
      at(
        "function q() { return Prisma.sql`UPDATE instance_rank SET claim = 'RELEASED'`; }\nasync function f(tx) { await tx.$executeRaw(q()); }",
      ),
    ).toEqual(["fragment", "opaque"]);
    expect(
      at(
        // An interpolation (`${part}`), spelled without a placeholder in this string.
        "const part = Prisma.sql`instance_rank`;\nasync function f(tx) { await tx.$executeRaw`UPDATE $" +
          "{part} SET claim = 'RELEASED'`; }",
      ),
    ).toEqual(["fragment", "raw-other"]);
    // The production wrapper reviewers named: an executor whose SQL comes from its callers.
    expect(
      at(
        "export async function queryAffinityResidency(sql, db) { return (db ?? client()).$queryRaw(sql); }",
      ),
    ).toEqual(["opaque"]);
    // Escapes as executed (instance_\u0072ank is instance_rank), in a string and a template.
    expect(at('tx.$executeRawUnsafe("UPDATE instance_\\u0072ank SET claim = 1")')).toEqual(["raw"]);
    expect(at("tx.$executeRaw`UPDATE instance_\\u0072ank SET claim = 1`")).toEqual(["raw"]);
    // Upper case, quoted model names and readable SQL naming no run table are still listed.
    expect(at("tx.$queryRawUnsafe('SELECT 1 FROM \"InstanceStep\"')")).toEqual(["raw"]);
    expect(at("tx.$queryRaw`SELECT 1`")).toEqual(["raw-other"]);
    expect(at("Prisma.raw(column)")).toEqual(["opaque"]);
    // Nested writes through every schema relation to a run model (Instance, LaunchInstances).
    expect(
      at("tx.executionTarget.update({ data: { Instance: { update: { phase: 'READY' } } } })"),
    ).toEqual(["nested"]);
    expect(
      at(
        "tx.runtimeVersion.update({ data: { LaunchInstances: { updateMany: { where: {}, data: { phase: 'STOPPING' } } } } })",
      ),
    ).toEqual(["nested"]);
    // A relation only filtered on (where) is a read, not a write.
    expect(
      at("tx.executionTarget.updateMany({ where: { Instance: { userId } }, data: { x: 1 } })"),
    ).toEqual([]);
    // Dynamic access: a computed delegate read, an aliased or destructured run delegate.
    expect(calls("db[model].findMany({})")).toEqual(["[computed].findMany"]);
    expect(at("const steps = tx.instanceStep; steps.updateMany({ data: {} })")).toEqual(["alias"]);
    expect(at("const { instanceRank } = tx;")).toEqual(["alias"]);
    expect(at("use(tx.runtimeInstance)")).toEqual(["alias"]);
    // Not a delegate: a hash's update, a map's delete.
    expect(at("createHash('sha256').update(text); seen.delete(id);")).toEqual([]);
    // A computed delegate, and a nested relation write from another delegate.
    expect(calls("tx[delegate].update({ data: {} })")).toEqual(["[computed].update"]);
    expect(
      at("tx.runtime.update({ data: { Instances: { create: { phase: 'STARTING' } } } })"),
    ).toEqual(["nested"]);
    // Removing claimStep's gate is caught.
    const lifecycle = read(LC);
    const withoutGate = lifecycle.replace("if (!owned(step, run)) {", "if (false) {");
    expect(withoutGate).not.toBe(lifecycle);
    expect(callers(LC, withoutGate, "owned")).not.toContain("claimStep");
    // A fixed-prefix sweep (A4-L2..L4) is caught; a cursor page and a stamp rotation are not.
    expect(
      unboundSweeps(
        "fixture.ts",
        "class A {\n  async s() {\n    return prisma.runtimeInstance.findMany({ where: {}, take: 256 });\n  }\n}",
      ),
    ).toEqual(["fixture.ts | s"]);
    expect(
      unboundSweeps(
        "fixture.ts",
        "class A {\n  async s() {\n    return this.c.next((page) => prisma.x.findMany({ where: page.where, take: page.take }));\n  }\n}",
      ),
    ).toEqual([]);
    expect(
      unboundSweeps(
        "fixture.ts",
        "class A {\n  async s() {\n    // sweep: stamp rotation (stamp)\n    return prisma.x.findMany({ where: {}, take: 64 });\n  }\n}",
      ),
    ).toEqual([]);
  });
});
