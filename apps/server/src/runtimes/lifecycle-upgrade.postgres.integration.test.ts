import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationSteps, stopStep } from "./steps.js";

// A populated upgrade from the released schema (master 94bbe08a, before runs existed): a database
// is created with that release's Prisma schema and hardening, a legacy graph is written into it
// (completed generations 1 and 2, a claim marked stopped, a committed restart whose steps were
// never prepared), then the candidate schema and hardening are pushed with the safe wrapper
// (`db:push`, no data loss accepted) and the real engine runs against it. Nothing is
// backfilled: `runGeneration` stays 0 until the engine bootstraps it from the rows' steps.
//
// Needs the release commit in the local git history: a shallow clone skips this suite, and fails
// it when REQUIRE_POSTGRES_INTEGRATION=1.

const BASE = "94bbe08a";
const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const dbRoot = path.join(repoRoot, "packages/db");
const baseAvailable = (() => {
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
// A required PostgreSQL run never skips this suite: CI fetches the release commit (pr-checks.yml,
// the server PostgreSQL job checks out the full history).
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && databaseUrl && !baseAvailable)
  throw new Error(
    `The upgrade suite needs the release commit ${BASE} in this clone's history (git fetch it, or check out with full history).`,
  );
if (databaseUrl && !baseAvailable)
  console.warn(`[upgrade] ${BASE} is not in this clone's history: the upgrade suite is skipped.`);
const integration = databaseUrl && baseAvailable ? describe : describe.skip;

const hex = (text: string) => createHash("sha256").update(text).digest("hex");
/** SQL literal for test-generated values. */
const lit = (value: string | number | null) =>
  value === null
    ? "NULL"
    : typeof value === "number"
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
/** Runs SQL (several statements, simple protocol) on `url` with the db package's `pg`. */
const SQL_RUNNER = `import pg from "pg";
let sql = "";
for await (const chunk of process.stdin) sql += chunk;
const client = new pg.Client({ connectionString: process.env.UPGRADE_SQL_URL });
await client.connect();
try { await client.query(sql); } finally { await client.end(); }`;
function runSql(url: string, sql: string) {
  execFileSync(process.execPath, ["--input-type=module", "-e", SQL_RUNNER], {
    cwd: dbRoot,
    env: { ...process.env, UPGRADE_SQL_URL: url },
    input: sql,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
const git = (args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

type Job = import("../relay/frames.js").RuntimeJobFrame;

integration("upgrade from the released schema (PostgreSQL, PG1)", () => {
  const suffix = randomUUID().slice(0, 8);
  const database = `wsmp_upgrade_${suffix}`;
  const upgradeUrl = (() => {
    const url = new URL(databaseUrl ?? "postgresql://localhost/none");
    url.pathname = `/${database}`;
    return url.toString();
  })();
  const userId = `upg-${suffix}`;
  const nodeId = `upgnode${suffix}`;
  const sent: Job[] = [];
  const previousUrl = process.env.DATABASE_URL;
  let tmp = "";
  let lifecycle: typeof import("./lifecycle.js");
  let prisma: typeof import("@ws-model-proxy/db")["default"];

  const launch = {
    management: "process" as const,
    groupSize: 1,
    resources: [{ kind: "none" as const }],
    labels: [],
    commands: [{ start: "serve --port {{port}}", stop: "true", status: "true" }],
    readiness: { path: "/v1/models", expectedStatus: 200, timeoutMs: 60_000 },
    health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
  };
  const spec = { api: "openai", engine: "vllm", modelType: "llm", models: [{ id: "m" }], launch };
  const instanceInput = (id: string) => ({
    id,
    handle: `i-${id.slice(0, 12)}`,
    runtimeId: `rt${suffix}`,
    launchVersionId: `v${suffix}`,
    launchHash: hex(`launch-${suffix}`),
    fabricId: null,
  });
  const RANK = { rank: 0, port: 30_501, distPort: null, resources: { kind: "none" } };
  const A = `a${hex(`a-${suffix}`).slice(0, 23)}`;
  const B = `b${hex(`b-${suffix}`).slice(0, 23)}`;

  beforeAll(async () => {
    runSql(databaseUrl ?? "", `CREATE DATABASE "${database}"`);
    // The released schema and hardening.
    tmp = mkdtempSync(path.join(os.tmpdir(), "wsmp-upgrade-"));
    const schemaDir = path.join(tmp, "schema");
    mkdirSync(schemaDir);
    for (const file of git(["ls-tree", "--name-only", BASE, "packages/db/prisma/schema/"])
      .split("\n")
      .filter(Boolean))
      writeFileSync(path.join(schemaDir, path.basename(file)), git(["show", `${BASE}:${file}`]));
    execFileSync(
      path.join(dbRoot, "node_modules/.bin/prisma"),
      ["db", "push", "--schema", schemaDir],
      {
        cwd: dbRoot,
        env: { ...process.env, DATABASE_URL: upgradeUrl },
        stdio: "pipe",
      },
    );
    {
      runSql(upgradeUrl, git(["show", `${BASE}:packages/db/prisma/schema-hardening.sql`]));
      // The legacy graph, written as the released server would have left it.
      const steps = (id: string, generation: number, operationId: string) =>
        generationSteps({
          instance: instanceInput(id),
          ranks: [RANK],
          launch,
          generation,
          operationId,
        });
      const g1a = steps(A, 1, `opA${suffix}`);
      const g2a = steps(A, 2, `opA${suffix}`);
      const stopA = stopStep({
        instance: instanceInput(A),
        rank: RANK,
        nnodes: 1,
        launch,
        generation: 1,
        attempt: 0,
        operationId: null,
      });
      const statusA = stopStep({
        instance: instanceInput(A),
        rank: RANK,
        nnodes: 1,
        launch,
        generation: 1,
        attempt: 0,
        operationId: null,
        phase: "STATUS",
      });
      const g1b = steps(B, 1, `opA${suffix}`);
      type Seed = {
        id: string;
        instanceId: string;
        step: {
          phase: string;
          sequence: number;
          generation: number;
          intent: unknown;
          intentHash: string;
        };
        state: string;
        attempts: number;
      };
      const seed =
        (instanceId: string, id: string, state: string, attempts: number) =>
        (step: Seed["step"]): Seed => ({
          id: id.replace("*", step.phase),
          instanceId,
          step,
          state,
          attempts,
        });
      const rows: Seed[] = [
        ...g1a.map(seed(A, `${A}-1-*`, "SUCCEEDED", 1)),
        seed(A, `${A}-1-GANG`, "SUCCEEDED", 1)(stopA),
        ...g2a.map(seed(A, `${A}-2-*`, "SUCCEEDED", 1)),
        // A generation-1 status probe re-queued by a reconnect (sent once, unanswered).
        seed(A, `${A}-1-STATUS`, "PENDING", 1)(statusA),
        // Operation A's generation 1 of B was prepared but never sent; then B was committed.
        ...g1b.map(seed(B, `${B}-1-*`, "PENDING", 0)),
      ];
      const statements: string[] = ["BEGIN", "SELECT set_config('wsmp.fences', ',*,', true)"];
      const query = (text: string, values: Array<string | number | null> = []) =>
        statements.push(
          text.replace(/\$(\d+)/g, (_, index) => lit(values[Number(index) - 1] ?? null)),
        );
      query(`INSERT INTO "user" (id, name, email, slug) VALUES ($1, 'Upgrade', $2, $1)`, [
        userId,
        `${userId}@example.test`,
      ]);
      query(
        `INSERT INTO node (id, "userId", slug, trust, connection, "connectionGeneration", "lastHeartbeatAt")
         VALUES ($1, $2, $3, 'FULL', 'ONLINE', 1, now())`,
        [nodeId, userId, `upg-${suffix}`],
      );
      query(
        `INSERT INTO runtime (id, "userId", slug, name, kind, origin) VALUES ($1, $2, $3, 'U', 'STARTABLE', 'SERVER')`,
        [`rt${suffix}`, userId, `upg-${suffix}`],
      );
      query(
        `INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
           "launchHash", spec, api, engine, "modelType")
         VALUES ($1, $2, 1, 'USER', $3, $4, $5, $6, 'OPENAI', 'VLLM', 'LLM')`,
        [
          `v${suffix}`,
          `rt${suffix}`,
          userId,
          hex(`content-${suffix}`),
          hex(`launch-${suffix}`),
          JSON.stringify(spec),
        ],
      );
      query(`UPDATE runtime SET "currentVersionId" = $1 WHERE id = $2`, [
        `v${suffix}`,
        `rt${suffix}`,
      ]);
      for (const op of [`opA${suffix}`, `opB${suffix}`])
        query(
          `INSERT INTO runtime_operation (id, "userId", kind, actor, "actorUserId", summary, fingerprint)
           VALUES ($1, $2, 'START', 'USER', $2, '{}', $3)`,
          [op, userId, hex(op)],
        );
      query(
        `INSERT INTO runtime_instance (id, "userId", "runtimeId", "versionId", "launchVersionId", handle,
           "operationId", "startedBy", "desiredState", phase)
         VALUES ($1, $3, $4, $5, $5, $6, $8, 'USER', 'STOPPED', 'STOPPED'),
                ($2, $3, $4, $5, $5, $7, $9, 'USER', 'RUNNING', 'STARTING')`,
        [
          A,
          B,
          userId,
          `rt${suffix}`,
          `v${suffix}`,
          `i-${A.slice(0, 12)}`,
          `i-${B.slice(0, 12)}`,
          `opA${suffix}`,
          `opB${suffix}`,
        ],
      );
      query(
        `INSERT INTO instance_rank (id, "instanceId", "nodeId", "unitName", rank, resources, port,
           claim, "markedStoppedAt", "markedStoppedBy")
         VALUES ($1, $2, $5, $6, 0, '{"kind":"none"}', 30501, 'HELD_UNKNOWN', now(), $7),
                ($3, $4, $5, $8, 0, '{"kind":"none"}', 30502, 'HELD', NULL, NULL)`,
        [
          `rank${A}`,
          A,
          `rank${B}`,
          B,
          nodeId,
          `wsmp-i-${A.slice(0, 12)}-r0`,
          userId,
          `wsmp-i-${B.slice(0, 12)}-r0`,
        ],
      );
      for (const { id, instanceId, step, state, attempts } of rows)
        query(
          `INSERT INTO instance_step (id, "instanceId", "nodeId", rank, phase, sequence, generation,
             intent, "intentHash", state, attempts, "updatedAt")
           VALUES ($1, $2, $3, 0, $4, $5, $6, $7, $8, $9, $10, now())`,
          [
            id,
            instanceId,
            nodeId,
            step.phase,
            step.sequence,
            step.generation,
            JSON.stringify(step.intent),
            step.intentHash,
            state,
            attempts,
          ],
        );
      statements.push("COMMIT");
      runSql(upgradeUrl, statements.join(";\n"));
    }
    // The candidate schema and hardening, as a deployment applies them (APPLY_SCHEMA=safe).
    for (const script of ["scripts/push-schema.mjs", "scripts/apply-schema-hardening.mjs"])
      execFileSync(process.execPath, [script], {
        cwd: dbRoot,
        env: { ...process.env, DATABASE_URL: upgradeUrl },
        stdio: "pipe",
      });
    process.env.DATABASE_URL = upgradeUrl;
    lifecycle = await import("./lifecycle.js");
    prisma = (await import("@ws-model-proxy/db")).default;
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    process.env.DATABASE_URL = previousUrl;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    runSql(databaseUrl ?? "", `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  });

  const ref = () => ({
    nodeId,
    userId,
    slug: `upg-${suffix}`,
    connectionGeneration: 1,
    trust: "full" as const,
  });
  const engine = () =>
    new lifecycle.RuntimeLifecycle({
      onlineNodeIds: () => [nodeId],
      sendToNode: (_node, frame) => {
        if (frame.type === "runtime.job") sent.push(frame);
        return true;
      },
      nodeSession: (id) =>
        id === nodeId ? { userId, connectionGeneration: 1, trust: "full" } : null,
    });
  const instance = (id: string) =>
    prisma.runtimeInstance.findUniqueOrThrow({ where: { id }, include: { Ranks: true } });
  const stepOf = (id: string) => prisma.instanceStep.findUniqueOrThrow({ where: { id } });

  it("keeps every legacy row, and the engine bootstraps runs without releasing or sending anything stale", async () => {
    // The safe push added the column without a backfill.
    expect((await instance(A)).runGeneration).toBe(0);
    expect((await instance(B)).runGeneration).toBe(0);
    expect(await prisma.instanceStep.count({ where: { instanceId: { in: [A, B] } } })).toBe(
      2 + 1 + 3 + 1 + 2,
    );
    const lc = engine();
    await lc.stop();
    // T7: generation 1's stop record, delayed, names an earlier run: nothing is released.
    const answer = await lc.runtimeInventory(ref(), {
      snapshotId: "u1",
      alwaysOn: [],
      instances: [
        {
          instanceId: A,
          launchVersionId: `v${suffix}`,
          launchHash: hex(`launch-${suffix}`),
          rank: 0,
          intentHash: hex("intent"),
          stepId: `${A}-1-GANG`,
          phase: "stopped",
          unitName: `wsmp-i-${A.slice(0, 12)}-r0`,
          port: 30_501,
          handle: `i-${A.slice(0, 12)}`,
          models: ["m"],
        },
      ],
    });
    expect(answer).toEqual({ ok: true, stale: [`i-${A.slice(0, 12)}`] });
    expect((await instance(A)).Ranks[0]?.claim).toBe("HELD_UNKNOWN");
    // The run was bootstrapped and persisted from the steps (generation 2 is current).
    expect((await instance(A)).runGeneration).toBe(2);

    // T8: dispatch reaches B before any preparation does: its run is bootstrapped as the
    // committed operation B (run 2), so operation A's START never goes out; nor does A's
    // re-queued generation-1 status probe.
    const dispatching = engine();
    await (dispatching as unknown as { dispatchSteps(): Promise<void> }).dispatchSteps();
    expect(sent.filter((job) => job.generation === 1)).toEqual([]);
    expect((await stepOf(`${B}-1-START`)).state).toBe("CANCELLED");
    expect((await instance(B)).runGeneration).toBe(2);
    expect(await stepOf(`${A}-1-STATUS`)).toMatchObject({
      state: "FAILED",
      errorCode: "superseded",
    });

    // The whole engine now: B's run 2 is prepared (leading stop first), A's run-2 probe goes out.
    await prisma.instanceRank.updateMany({
      where: { instanceId: A },
      data: { lastStopCheckAt: null },
    });
    await dispatching.runOnce();
    await dispatching.runOnce();
    const leading = [...sent].reverse().find((job) => job.instanceId === B && job.phase === "stop");
    expect(leading?.generation).toBe(2);
    const probe = [...sent].reverse().find((job) => job.instanceId === A && job.phase === "status");
    if (!probe) throw new Error("no status probe for A");
    expect(probe.generation).toBe(2);
    // I8: generation 2's own proof releases the legacy claim.
    await dispatching.handleJobResult(ref(), {
      type: "runtime.job.result",
      stepId: probe.stepId,
      instanceId: A,
      rank: 0,
      intentHash: probe.intentHash,
      ownerEpoch: probe.ownerEpoch,
      status: "succeeded",
      stopped: true,
    });
    await dispatching.stop();
    expect((await instance(A)).Ranks[0]?.claim).toBe("RELEASED");
    expect(sent.filter((job) => job.generation === 1)).toEqual([]);
  });
});
