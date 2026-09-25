import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Static guard for the capacity-domain lock order documented and enforced in
// packages/db/src/capacity-lock-order.ts (DL-1). Capacity admission holds the
// capacity advisory lock and row (L4/L5) while its capacity_lease /
// capacity_waiter / admission_request / cache_affinity_record inserts take
// FOR KEY SHARE on their parent rows. A parent row held in a mode that
// conflicts with KEY SHARE (FOR UPDATE) by a transaction that then waits on a
// capacity lock is a lock-order inversion. PostgreSQL takes that mode:
//   1. explicitly: SELECT ... FOR UPDATE on the parent table;
//   2. implicitly: INSERT ... ON CONFLICT DO UPDATE whose SET list names a
//      key column (any column of a unique index), even for an unchanged
//      value (ExecUpdateLockMode) — Prisma compiles a native upsert this way;
//   3. implicitly: UPDATE that changes a key column value, and DELETE.
// This guard rejects (1) and (2) everywhere, and (3) for UPDATE except at the
// reviewed sites listed below. DELETE ordering is enforced at runtime by
// lockCapacityGraphForDelete and exercised on PostgreSQL; the one explicit
// user FOR UPDATE (L7) is checked by position (findL7Violations).

// Parent tables whose rows capacity admission references through foreign keys.
const FK_PARENT_TABLES = [
  "execution_target",
  "model_pool",
  "pool_member",
  "user",
  "inference_capacity",
  "admission_request",
  "relay_request",
];
// inference_capacity (L5) and admission_request (L6) are locked FOR UPDATE by
// the admitter itself, in the documented order; only the four L1/L2 parents
// must never be locked FOR UPDATE explicitly.
const NO_FOR_UPDATE_TABLES = ["execution_target", "model_pool", "pool_member", "user"];

/**
 * UPDATE sites that may change a key-column value on a guarded table, each
 * with its reviewed reason. Key: `<relative file>:<delegate or table>.<column>`.
 */
const REVIEWED_KEY_COLUMN_UPDATES: Record<string, string> = {
  "packages/api/src/routers/forwarder-management.ts:modelPool.slug":
    "updateModelPool renames the slug after every lock wait of its transaction (L1, L2); the statements after it only insert notices.",
  "packages/api/src/routers/forwarder-management.ts:user.slug":
    "setUserSlug is an autocommit single-statement write: no lock is held before it and no capacity lock follows it.",
  "packages/db/scripts/verify-schema-hardening.mjs:execution_target.discoveredModelId":
    "Schema verification against a disposable database: asserts the identity-immutable trigger rejects this update.",
  "packages/db/scripts/verify-schema-hardening.mjs:execution_target.userId":
    "Schema verification against a disposable database: asserts the identity-immutable trigger rejects this update.",
};

/**
 * Explicit FOR SHARE locks on an L1/L2 parent table (FOR SHARE conflicts with
 * the FOR NO KEY UPDATE of writers and of the deletion mark, unlike the FOR
 * KEY SHARE of child inserts), each with its reviewed reason. Key:
 * `<relative file>:<table>.FOR SHARE`.
 */
const REVIEWED_SHARE_LOCKS: Record<string, string> = {
  "packages/db/prisma/schema-hardening.sql:user.FOR SHARE":
    "session_refuse_deleting_user (DEL-STATE commit point): a BEFORE INSERT ON session trigger. The session inserter holds no capacity lock and takes none afterwards (a single-statement insert, or sign-up's transaction on a brand-new user row), so its wait on a mark, an L7 user lock or a user writer is outside the capacity domain and closes no cycle.",
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../../..");
const scannedRoots = [
  "apps/server/src",
  "packages/api/src",
  "packages/auth/src",
  "packages/db/src",
  "packages/db/scripts",
  "packages/db/prisma",
  "scripts",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "generated", "e2e"].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(tsx?|mjs|sql)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Key columns (every column of a unique index or id) per Prisma model. */
function keyColumnsByModel(): Map<string, { table: string; keys: Set<string> }> {
  const schemaDir = join(repoRoot, "packages/db/prisma/schema");
  const models = new Map<string, { table: string; keys: Set<string> }>();
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".prisma"))) {
    const source = readFileSync(join(schemaDir, file), "utf8");
    for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
      const [, model = "", body = ""] = match;
      const keys = new Set<string>();
      let table = model;
      for (const line of body.split("\n")) {
        const field = line.match(/^\s*(\w+)\s+\S+.*@(id|unique)\b/);
        if (field?.[1]) keys.add(field[1]);
        const composite = line.match(/@@(?:unique|id)\(\[([^\]]+)\]/);
        if (composite?.[1])
          for (const column of composite[1].split(","))
            keys.add(column.trim().split(/[\s(]/)[0] ?? "");
        const mapped = line.match(/@@map\("([^"]+)"\)/);
        if (mapped?.[1]) table = mapped[1];
      }
      models.set(model, { table, keys });
    }
  }
  return models;
}

const MODELS = keyColumnsByModel();
const GUARDED_MODELS = [...MODELS.entries()].filter(([, model]) =>
  FK_PARENT_TABLES.includes(model.table),
);

function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Text of the balanced (...) or {...} group starting at `start`. */
function balanced(source: string, start: number): string {
  const open = source[start];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === open) depth++;
    else if (char === close && --depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

/**
 * Property names an object literal assigns: its own top-level keys plus the
 * top-level keys of object literals spread into it (`...(c ? { a } : {})`).
 */
function assignedKeys(objectText: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let spreadDepth: number | null = null;
  let quote: string | null = null;
  let expectKey = false;
  for (let index = 0; index < objectText.length; index++) {
    const char = objectText[index] ?? "";
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{" || char === "(" || char === "[") {
      depth++;
      expectKey = char === "{";
      continue;
    }
    if (char === "}" || char === ")" || char === "]") {
      depth--;
      if (spreadDepth !== null && depth < spreadDepth) spreadDepth = null;
      continue;
    }
    if (char === ",") {
      if (depth === 1) spreadDepth = null;
      expectKey = true;
      continue;
    }
    if (depth === 1 && objectText.startsWith("...", index)) {
      spreadDepth = 1;
      index += 2;
      continue;
    }
    if (!expectKey || /\s/.test(char)) continue;
    expectKey = false;
    const inScope =
      depth === 1 || (spreadDepth !== null && depth >= spreadDepth + 1 && depth <= spreadDepth + 2);
    if (!inScope) continue;
    const key = objectText.slice(index).match(/^([A-Za-z_$][\w$]*)\s*[:,}]/);
    if (key?.[1]) keys.push(key[1]);
  }
  return keys;
}

/** The object literal assigned to `property` at the top level of a call argument. */
function propertyObject(argument: string, property: string): string | null {
  const match = new RegExp(`(?:^|[\\s,{])${property}\\s*:\\s*\\{`).exec(argument);
  if (!match) return null;
  return balanced(argument, match.index + match[0].length - 1);
}

type Finding = { file: string; site: string; detail: string };

function findPrismaKeyColumnWrites(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const [model, { keys }] of GUARDED_MODELS) {
    const delegate = delegateName(model);
    const call = new RegExp(`\\.${delegate}\\.(upsert|update|updateMany)\\(`, "g");
    for (const match of source.matchAll(call)) {
      const method = match[1] ?? "";
      const argument = balanced(source, (match.index ?? 0) + match[0].length - 1);
      const object = propertyObject(argument, method === "upsert" ? "update" : "data");
      if (!object) continue;
      for (const key of assignedKeys(object)) {
        if (!keys.has(key)) continue;
        findings.push({
          file,
          site: `${delegate}.${key}`,
          detail: `${delegate}.${method} assigns key column "${key}"`,
        });
      }
    }
  }
  return findings;
}

function sqlStatements(file: string, source: string): string[] {
  if (file.endsWith(".sql")) return source.split(/;\s*(?:\n|$)/);
  return [...source.matchAll(/`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)].map(
    (match) => match[0],
  );
}

function tableModel(table: string) {
  return GUARDED_MODELS.find(([, model]) => model.table === table)?.[1];
}

function setColumns(setList: string): string[] {
  return [...setList.matchAll(/(?:^|,)\s*"?([A-Za-z_]\w*)"?\s*=/g)].map((match) => match[1] ?? "");
}

function findSqlLockOrderViolations(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of sqlStatements(file, source)) {
    const sql = raw.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
    if (/\bFOR\s+UPDATE\b/i.test(sql) && !sql.includes("lock-order:L7"))
      for (const table of NO_FOR_UPDATE_TABLES) {
        const from = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?"?${table}"?(?:\\s|$)`, "i");
        if (from.test(sql))
          findings.push({ file, site: `${table}.FOR UPDATE`, detail: sql.slice(0, 140) });
      }
    if (/\bFOR\s+SHARE\b/i.test(sql))
      for (const table of NO_FOR_UPDATE_TABLES) {
        const from = new RegExp(`\\b(?:FROM|JOIN)\\s+(?:ONLY\\s+)?"?${table}"?(?:\\s|$)`, "i");
        if (from.test(sql))
          findings.push({ file, site: `${table}.FOR SHARE`, detail: sql.slice(0, 140) });
      }
    const upsert = sql.match(
      /\bINSERT\s+INTO\s+(?:"?public"?\.)?"?(\w+)"?[\s\S]*?\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i,
    );
    const upsertModel = upsert?.[1] ? tableModel(upsert[1]) : undefined;
    if (upsert && upsertModel)
      for (const column of setColumns(upsert[2] ?? ""))
        if (upsertModel.keys.has(column))
          findings.push({
            file,
            site: `${upsertModel.table}.${column}`,
            detail: `ON CONFLICT DO UPDATE SET names key column "${column}"`,
          });
    const update = sql.match(
      /\bUPDATE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?(\w+)"?(?:\s+\w+)?\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i,
    );
    const updateModel = update?.[1] ? tableModel(update[1]) : undefined;
    if (update && updateModel && !/\bON\s+CONFLICT\b/i.test(sql))
      for (const column of setColumns(update[2] ?? ""))
        if (updateModel.keys.has(column))
          findings.push({
            file,
            site: `${updateModel.table}.${column}`,
            detail: `UPDATE assigns key column "${column}"`,
          });
  }
  return findings;
}

/**
 * The one site allowed to take the user row FOR UPDATE (L7): inside
 * lockCapacityGraphForDelete, after the L0-L6 locks it takes. The
 * `lock-order:L7` annotation alone exempts nothing: a tagged statement
 * elsewhere, or one that precedes an L0-L6 lock in its function, is a
 * finding (the pass-8 inversion carried the tag).
 */
const L7_SITE = {
  file: "packages/db/src/capacity-lock-order.ts",
  fn: "lockCapacityGraphForDelete",
};
/** Calls and statements that take L0-L6 (directly or through the helper). */
const L0_L6_LOCKS = [
  /\blockCapacityGraphForDelete\s*\(/g,
  /\blockExecutionTargetPolicies\s*\(/g,
  /\blockCapacityAdmissionResources\s*\(/g,
  /\blockCapacityRowsForPolicyWrite\s*\(/g,
  /FROM\s+(?:cli_device|model_pool|admission_request|inference_capacity)\b[^`]*\bFOR\s+(?:NO\s+KEY\s+)?UPDATE/g,
];
/** L0-L6 locks the allow-listed site must take before its L7 statement. */
const L7_SITE_PREREQUISITES = [
  /\blockExecutionTargetPolicies\s*\(/,
  /\blockCapacityAdmissionResources\s*\(/,
];

/** Name and body range of the innermost named function enclosing `offset`. */
function enclosingFunction(
  source: string,
  offset: number,
): { name: string; start: number; end: number } | null {
  let found: { name: string; start: number; end: number } | null = null;
  for (const match of source.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\(/g)) {
    const paren = (match.index ?? 0) + match[0].length - 1;
    if (paren > offset) break;
    const params = balanced(source, paren);
    const brace = source.indexOf("{", paren + params.length);
    if (brace < 0) continue;
    const body = balanced(source, brace);
    const end = brace + body.length;
    if (brace < offset && offset < end) found = { name: match[1] ?? "", start: brace, end };
  }
  return found;
}

function findL7Violations(file: string, source: string): Finding[] {
  if (file.endsWith(".sql")) return [];
  const findings: Finding[] = [];
  let from = 0;
  for (const raw of sqlStatements(file, source)) {
    const at = source.indexOf(raw, from);
    if (at >= 0) from = at + raw.length;
    const sql = raw.replace(/\s+/g, " ");
    if (!sql.includes("lock-order:L7") || !/\bFOR\s+UPDATE\b/i.test(sql)) continue;
    const fn = at >= 0 ? enclosingFunction(source, at) : null;
    if (!fn || file !== L7_SITE.file || fn.name !== L7_SITE.fn) {
      findings.push({
        file,
        site: "user.L7",
        detail: `L7 user lock outside ${L7_SITE.fn}: ${sql.slice(0, 100)}`,
      });
      continue;
    }
    const before = source.slice(fn.start, at);
    const after = source.slice(at + raw.length, fn.end);
    for (const lock of L0_L6_LOCKS)
      if (new RegExp(lock.source, "i").test(after))
        findings.push({
          file,
          site: "user.L7",
          detail: `L0-L6 lock after the L7 user lock: ${lock.source}`,
        });
    for (const lock of L7_SITE_PREREQUISITES)
      if (!lock.test(before))
        findings.push({ file, site: "user.L7", detail: `L7 user lock before ${lock.source}` });
  }
  return findings;
}

function scan(): Finding[] {
  return scannedRoots.flatMap((root) =>
    sourceFiles(join(repoRoot, root)).flatMap((path) => {
      const file = relative(repoRoot, path);
      const source = readFileSync(path, "utf8");
      return [
        ...(file.endsWith(".sql") ? [] : findPrismaKeyColumnWrites(file, source)),
        ...findSqlLockOrderViolations(file, source),
        ...findL7Violations(file, source),
      ];
    }),
  );
}

describe("capacity-domain lock order", () => {
  it("derives key columns from the Prisma schema", () => {
    const target = MODELS.get("ExecutionTarget");
    expect(target?.table).toBe("execution_target");
    expect([...(target?.keys ?? [])]).toEqual(
      expect.arrayContaining(["id", "userId", "discoveredModelId", "providerModelId"]),
    );
    expect(target?.keys.has("inferenceCapacityId")).toBe(false);
    expect(MODELS.get("ModelPool")?.keys.has("slug")).toBe(true);
    expect(GUARDED_MODELS.map(([model]) => model)).toEqual(
      expect.arrayContaining(["ExecutionTarget", "ModelPool", "PoolMember", "User"]),
    );
  });

  it("detects explicit FOR UPDATE on FK parent rows and accepts FOR NO KEY UPDATE", () => {
    const check = (source: string) => findSqlLockOrderViolations("probe.ts", source);
    expect(
      check("tx.$queryRaw`SELECT id FROM execution_target WHERE id = $1 FOR UPDATE`"),
    ).toHaveLength(1);
    expect(check("tx.$queryRaw`\n  SELECT id FROM model_pool\n  FOR UPDATE\n`")).toHaveLength(1);
    expect(check('await client.query("SELECT id FROM pool_member FOR UPDATE")')).toHaveLength(1);
    expect(
      check("tx.$queryRaw`SELECT id FROM execution_target WHERE id = $1 FOR NO KEY UPDATE`"),
    ).toEqual([]);
    expect(check("tx.$queryRaw`SELECT id FROM inference_capacity FOR UPDATE`")).toEqual([]);
    expect(
      check('tx.$queryRaw`SELECT id FROM "user" WHERE id = $1 FOR UPDATE /* lock-order:L7 */`'),
    ).toEqual([]);
    expect(
      findSqlLockOrderViolations("probe.sql", "SELECT 1 FROM model_pool m FOR UPDATE;\n"),
    ).toHaveLength(1);
  });

  it("checks the position of an L7-tagged user lock, not only its tag", () => {
    // The pass-8 inversion: the tagged user lock precedes the L0-L6 helper.
    const pass8 = `export async function deleteUserInCapacityLockOrder(
  db: TransactionRunner,
  userId: string,
  deletionRequestedAt: Date,
): Promise<boolean> {
  return runCapacityOrderedTransaction(db, async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>\`
      SELECT id FROM "user"
       WHERE id = \${userId} AND "deletionRequestedAt" = \${deletionRequestedAt}
       FOR UPDATE /* lock-order:L7 */\`;
    if (locked.length === 0) return false;
    await lockCapacityGraphForDelete(tx, { userId, wholeUser: true });
    return true;
  });
}`;
    expect(findL7Violations(L7_SITE.file, pass8)).not.toEqual([]);
    expect(findL7Violations("packages/api/src/probe.ts", pass8)).not.toEqual([]);
    // The helper's own statement, after L0-L6: accepted.
    const helper = `export async function lockCapacityGraphForDelete(tx: Tx, scope: S): Promise<void> {
  await lockExecutionTargetPolicies(tx, planned.targets);
  await lockCapacityAdmissionResources(tx, planned.capacities);
  if (scope.wholeUser) {
    await tx.$queryRaw\`SELECT id FROM "user" WHERE id = \${scope.userId} FOR UPDATE /* lock-order:L7 */\`;
  }
}`;
    expect(findL7Violations(L7_SITE.file, helper)).toEqual([]);
    // The same statement moved ahead of the capacity locks: rejected.
    const early = `export async function lockCapacityGraphForDelete(tx: Tx, scope: S): Promise<void> {
  await tx.$queryRaw\`SELECT id FROM "user" WHERE id = \${scope.userId} FOR UPDATE /* lock-order:L7 */\`;
  await lockExecutionTargetPolicies(tx, planned.targets);
  await lockCapacityAdmissionResources(tx, planned.capacities);
}`;
    expect(findL7Violations(L7_SITE.file, early)).not.toEqual([]);
  });

  it("detects key-column SETs in upserts and updates", () => {
    // The pre-fix registration upsert: SET "userId" on execution_target.
    expect(
      findPrismaKeyColumnWrites(
        "probe.ts",
        `await tx.executionTarget.upsert({
          where: { discoveredModelId: id },
          update: { userId: identity.userId, kind: "DISCOVERED_MODEL" },
          create: { userId: identity.userId, kind: "DISCOVERED_MODEL", discoveredModelId: id },
        });`,
      ).map((finding) => finding.site),
    ).toEqual(["executionTarget.userId"]);
    expect(
      findPrismaKeyColumnWrites(
        "probe.ts",
        "await tx.executionTarget.upsert({ where: { providerModelId: id }, update: {}, create: { userId } });",
      ),
    ).toEqual([]);
    expect(
      findPrismaKeyColumnWrites(
        "probe.ts",
        "await tx.modelPool.update({ where: { id }, data: { name, ...(slug ? { slug } : {}) } });",
      ).map((finding) => finding.site),
    ).toEqual(["modelPool.slug"]);
    expect(
      findPrismaKeyColumnWrites(
        "probe.ts",
        "await tx.executionTarget.update({ where: { id }, data: { inferenceCapacityId: c } });",
      ),
    ).toEqual([]);
    expect(
      findSqlLockOrderViolations(
        "probe.ts",
        'db.$executeRaw`INSERT INTO "public"."execution_target" ("id","userId") VALUES ($1,$2) ON CONFLICT ("discoveredModelId") DO UPDATE SET "userId" = $3, "kind" = $4 RETURNING id`',
      ).map((finding) => finding.site),
    ).toEqual(["execution_target.userId"]);
    expect(
      findSqlLockOrderViolations(
        "probe.sql",
        'UPDATE pool_member SET "executionTargetId" = t.id FROM x t WHERE pool_member.id = t.id;\n',
      ).map((finding) => finding.site),
    ).toEqual(["pool_member.executionTargetId"]);
    expect(
      findSqlLockOrderViolations(
        "probe.sql",
        "UPDATE capacity_waiter SET state = 'CANCELLED' WHERE id = 1;\nUPDATE model_pool SET name = 'x';\n",
      ),
    ).toEqual([]);
  });

  it("finds no capacity lock-order violation in production and deploy sources", () => {
    const unreviewed = scan().filter(
      (finding) =>
        !REVIEWED_KEY_COLUMN_UPDATES[`${finding.file}:${finding.site}`] &&
        !REVIEWED_SHARE_LOCKS[`${finding.file}:${finding.site}`],
    );
    expect(unreviewed.map((finding) => `${finding.file}: ${finding.detail}`)).toEqual([]);
  });

  it("keeps every reviewed key-column update site live", () => {
    const sites = new Set(scan().map((finding) => `${finding.file}:${finding.site}`));
    expect(Object.keys(REVIEWED_KEY_COLUMN_UPDATES).filter((site) => !sites.has(site))).toEqual([]);
    expect(Object.keys(REVIEWED_SHARE_LOCKS).filter((site) => !sites.has(site))).toEqual([]);
  });

  it("flags explicit FOR SHARE on an L1/L2 parent row, not FOR KEY SHARE", () => {
    const check = (source: string) =>
      findSqlLockOrderViolations("probe.sql", source).map((finding) => finding.site);
    expect(check('SELECT 1 FROM "user" u WHERE u.id = NEW."userId" FOR SHARE;\n')).toEqual([
      "user.FOR SHARE",
    ]);
    expect(check("SELECT id FROM model_pool WHERE id = 1 FOR SHARE;\n")).toEqual([
      "model_pool.FOR SHARE",
    ]);
    expect(check('SELECT 1 FROM "user" WHERE id = 1 FOR KEY SHARE;\n')).toEqual([]);
  });
});
