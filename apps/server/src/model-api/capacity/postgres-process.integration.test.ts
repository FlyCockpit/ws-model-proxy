import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, describe, expect, it } from "vitest";
import type { AdmissionAttempt, CapacityLeaseHandle } from "./types.js";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error(
    "PostgreSQL integration was required but SCHEMA_VALIDATION_DATABASE_URL is unset.",
  );
const integration = databaseUrl ? describe : describe.skip;
const workerPath = fileURLToPath(new URL("./postgres-process-worker.ts", import.meta.url));

type SerializableLease = Omit<CapacityLeaseHandle, "fencingToken" | "expiresAt"> & {
  fencingToken: string;
  expiresAt: string;
};
type WorkerResult =
  | { state: "WAITING" | "CANCELLED" | "EXPIRED"; requestId?: string }
  | { state: "ADMITTED"; lease: SerializableLease }
  | { reclaimed: number }
  | { released: boolean }
  | { winner?: { admissionRequestId: string; priority: number } };

function startWorker(command: unknown) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, Buffer.from(JSON.stringify(command)).toString("base64url")],
    {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
      env: { ...process.env, SCHEMA_VALIDATION_DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const result = new Promise<WorkerResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      const line = stdout.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (line) resolve(JSON.parse(line) as WorkerResult);
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (stdout.includes("{")) return;
      reject(new Error(`capacity worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, result };
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

integration("capacity admission across operating-system processes", () => {
  const db = databaseUrl ? createPrismaClient(databaseUrl) : undefined;
  const children = new Set<ChildProcess>();
  afterAll(async () => {
    await Promise.all([...children].map(stop));
    await db?.$disconnect();
  });

  it("fences concurrent workers and recovers admitted and streaming work after SIGKILL", async () => {
    if (!db) return;
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Process capacity proof", email: `process-capacity-${suffix}@example.test` },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `process-capacity-${suffix}`,
        runtimeIdentityKey: `process-runtime-${suffix}`,
        runtimeModel: "process-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "process-proof",
        label: `process-account-${suffix}`,
        baseUrl: "https://example.test",
        authType: "BEARER",
      },
    });
    const model = await db.providerModel.create({
      data: { userId: owner.id, providerAccountId: account.id, upstreamModelId: suffix },
    });
    const target = await db.executionTarget.create({
      data: {
        userId: owner.id,
        kind: "PROVIDER_MODEL",
        providerModelId: model.id,
        inferenceCapacityId: capacity.id,
      },
    });
    const attempt = (
      label: string,
    ): Omit<AdmissionAttempt, "deadlineAt"> & { deadlineAt: string } => ({
      attemptId: `${label}-${suffix}`,
      requestId: `${label}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT",
      basePriority: 16,
      connectionOwner: `${label}-process`,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
    });

    for (const phase of ["admitted", "streaming"] as const) {
      const holder = startWorker({
        operation: "acquire",
        attempt: attempt(`${phase}-holder`),
        hold: true,
      });
      children.add(holder.child);
      const holderResult = await holder.result;
      expect(holderResult).toMatchObject({ state: "ADMITTED" });
      if (!("state" in holderResult) || holderResult.state !== "ADMITTED")
        throw new Error("Holder was not admitted.");
      const contender = startWorker({
        operation: "acquire",
        attempt: attempt(`${phase}-contender`),
        hold: false,
      });
      children.add(contender.child);
      const contenderResult = await contender.result;
      expect(contenderResult).toMatchObject({ state: "WAITING" });
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(1);

      await stop(holder.child);
      children.delete(holder.child);
      await db.$executeRaw`
        UPDATE "CapacityLease" SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
         WHERE id = ${holderResult.lease.leaseId}`;
      const sweepers = [
        startWorker({ operation: "reclaim", limit: 10 }),
        startWorker({ operation: "reclaim", limit: 10 }),
      ];
      for (const sweeper of sweepers) children.add(sweeper.child);
      const sweepResults = await Promise.all(sweepers.map((sweeper) => sweeper.result));
      expect(
        sweepResults.reduce(
          (total, result) => total + ("reclaimed" in result ? result.reclaimed : 0),
          0,
        ),
      ).toBe(1);

      const recovered = startWorker({
        operation: "acquire",
        attempt: { ...attempt(`${phase}-contender`), candidates: [] },
        hold: false,
      });
      children.add(recovered.child);
      const recoveredResult = await recovered.result;
      expect(recoveredResult).toMatchObject({ state: "ADMITTED" });
      if (!("state" in recoveredResult) || recoveredResult.state !== "ADMITTED")
        throw new Error("Contender did not recover.");
      expect(BigInt(recoveredResult.lease.fencingToken)).toBeGreaterThan(
        BigInt(holderResult.lease.fencingToken),
      );
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(1);
      const releaser = startWorker({ operation: "release", lease: recoveredResult.lease });
      children.add(releaser.child);
      await expect(releaser.result).resolves.toEqual({ released: true });
    }

    // Persist scheduler state in PostgreSQL, then let different OS processes
    // advance it. The high-weight class receives its remaining turn, the
    // cursor advances to the low class (bounded anti-starvation), and FIFO is
    // stable within that class.
    const deficits = Array(32).fill(0) as number[];
    deficits[31] = 1;
    await db.inferenceCapacity.update({
      where: { id: capacity.id },
      data: { schedulerCursor: 31, schedulerDeficits: deficits },
    });
    const weightedCandidates = [
      {
        admissionRequestId: `high-${suffix}`,
        waiterId: `high-${suffix}`,
        candidateOrder: 0,
        priority: 31,
        enqueueSequence: "2",
        eligible: true,
      },
      {
        admissionRequestId: `low-${suffix}`,
        waiterId: `low-${suffix}`,
        candidateOrder: 0,
        priority: 0,
        enqueueSequence: "1",
        eligible: true,
      },
    ];
    const highRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: weightedCandidates,
    });
    children.add(highRound.child);
    await expect(highRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `high-${suffix}`, priority: 31 },
    });
    const lowRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: weightedCandidates,
    });
    children.add(lowRound.child);
    await expect(lowRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `low-${suffix}`, priority: 0 },
    });
    const fifoRound = startWorker({
      operation: "schedule",
      capacityId: capacity.id,
      candidates: [
        {
          admissionRequestId: `later-${suffix}`,
          waiterId: `later-${suffix}`,
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: "4",
          eligible: true,
        },
        {
          admissionRequestId: `earlier-${suffix}`,
          waiterId: `earlier-${suffix}`,
          candidateOrder: 0,
          priority: 0,
          enqueueSequence: "3",
          eligible: true,
        },
      ],
    });
    children.add(fifoRound.child);
    await expect(fifoRound.result).resolves.toMatchObject({
      winner: { admissionRequestId: `earlier-${suffix}` },
    });

    await db.user.delete({ where: { id: owner.id } });
  }, 30_000);
});
