import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
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
  | { heartbeat: boolean }
  | { winner?: { admissionRequestId: string; priority: number } }
  | { port: number };

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

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for process integration handshake.");
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

  it("runs real Hono workers through precommit and committed stream crashes", async () => {
    if (!db) return;
    const pendingUpstreams: ServerResponse[] = [];
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests++;
      pendingUpstreams.push(response);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Upstream did not bind TCP.");
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: { name: "Hono process proof", email: `hono-process-${suffix}@example.test` },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `hono-capacity-${suffix}`,
        runtimeIdentityKey: `hono-runtime-${suffix}`,
        runtimeModel: "hono-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const account = await db.providerAccount.create({
      data: {
        userId: owner.id,
        providerType: "hono-proof",
        label: `hono-account-${suffix}`,
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
    const attempt = (label: string) => ({
      attemptId: `${label}-${suffix}`,
      requestId: `${label}-${suffix}`,
      ownerId: owner.id,
      sourceKind: "DIRECT" as const,
      basePriority: 16,
      connectionOwner: `${label}-hono`,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      candidates: [{ capacityId: capacity.id, executionTargetId: target.id, candidateOrder: 0 }],
    });
    const upstreamUrl = `http://127.0.0.1:${address.port}/controlled`;
    const servers = [
      startWorker({ operation: "server", upstreamUrl }),
      startWorker({ operation: "server", upstreamUrl }),
    ];
    for (const server of servers) children.add(server.child);
    const serverResults = await Promise.all(servers.map((server) => server.result));
    const ports = serverResults.map((result) => {
      if (!("port" in result)) throw new Error("Hono worker did not report its port.");
      return result.port;
    });

    try {
      for (const phase of ["precommit", "committed-stream"] as const) {
        const holderAttempt = attempt(`${phase}-holder`);
        const contenderAttempt = attempt(`${phase}-contender`);
        const work = fetch(`http://127.0.0.1:${ports[0]}/work`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(holderAttempt),
        });
        const upstreamResponse = await waitFor(() => pendingUpstreams.shift());
        const waiting = await fetch(`http://127.0.0.1:${ports[1]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(contenderAttempt),
        });
        expect(waiting.status).toBe(202);
        expect(await waiting.json()).toMatchObject({ state: "WAITING" });

        let committedFence: string | null = null;
        if (phase === "committed-stream") {
          upstreamResponse.writeHead(200, { "content-type": "text/event-stream" });
          upstreamResponse.write("data: first\n\n");
          const response = await work;
          expect(response.status).toBe(200);
          committedFence = response.headers.get("x-capacity-fence");
          const first = await response.body?.getReader().read();
          expect(new TextDecoder().decode(first?.value)).toContain("data: first");
        }
        const oldLease = await db.capacityLease.findUniqueOrThrow({
          where: { attemptId: holderAttempt.attemptId },
        });
        await stop(servers[0]!.child);
        children.delete(servers[0]!.child);
        if (phase === "precommit") await expect(work).rejects.toBeDefined();
        upstreamResponse.destroy();
        await db.$executeRaw`
          UPDATE "CapacityLease" SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
           WHERE id = ${oldLease.id}`;
        const reclaim = startWorker({ operation: "reclaim", limit: 10 });
        children.add(reclaim.child);
        await expect(reclaim.result).resolves.toEqual({ reclaimed: 1 });
        const recovery = await fetch(`http://127.0.0.1:${ports[1]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...contenderAttempt, candidates: [] }),
        });
        expect(recovery.status).toBe(200);
        const replacement = (await recovery.json()) as { state: string; lease: SerializableLease };
        expect(replacement.state).toBe("ADMITTED");
        expect(BigInt(replacement.lease.fencingToken)).toBeGreaterThan(oldLease.fencingToken);
        if (committedFence) expect(BigInt(committedFence)).toBe(oldLease.fencingToken);

        const staleLease: SerializableLease = {
          leaseId: oldLease.id,
          attemptId: oldLease.attemptId,
          capacityId: oldLease.capacityId,
          executionTargetId: oldLease.executionTargetId,
          poolMemberId: oldLease.poolMemberId ?? undefined,
          fencingToken: oldLease.fencingToken.toString(),
          expiresAt: oldLease.expiresAt.toISOString(),
          reservationClass: oldLease.reservationClass,
          borrowed: oldLease.borrowed,
        };
        const staleHeartbeat = startWorker({
          operation: "heartbeat",
          lease: staleLease,
          extensionMs: 30_000,
        });
        const staleRelease = startWorker({ operation: "release", lease: staleLease });
        children.add(staleHeartbeat.child);
        children.add(staleRelease.child);
        await expect(staleHeartbeat.result).resolves.toEqual({ heartbeat: false });
        await expect(staleRelease.result).resolves.toEqual({ released: false });
        expect(
          await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
        ).toBe(1);
        const released = await fetch(
          `http://127.0.0.1:${ports[1]}/release/${contenderAttempt.attemptId}`,
          { method: "POST" },
        );
        expect(await released.json()).toEqual({ released: true });
        const secondRepair = startWorker({ operation: "reclaim", limit: 10 });
        children.add(secondRepair.child);
        await expect(secondRepair.result).resolves.toEqual({ reclaimed: 0 });

        const replacementServer = startWorker({ operation: "server", upstreamUrl });
        children.add(replacementServer.child);
        const replacementResult = await replacementServer.result;
        if (!("port" in replacementResult)) throw new Error("Restarted worker has no port.");
        ports[0] = replacementResult.port;
        servers[0] = replacementServer;
      }
      const interruptedAttempt = attempt("network-interrupted");
      const interruptedWork = fetch(`http://127.0.0.1:${ports[0]}/work`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(interruptedAttempt),
      });
      const interruptedUpstream = await waitFor(() => pendingUpstreams.shift());
      interruptedUpstream.destroy(new Error("deterministic upstream disconnect"));
      await expect(interruptedWork).resolves.toMatchObject({ status: 500 });
      await waitFor(() =>
        db.capacityLease
          .findUnique({ where: { attemptId: interruptedAttempt.attemptId } })
          .then((lease) => (lease?.state === "RELEASED" ? lease : undefined)),
      );
      expect(
        await db.capacityLease.count({ where: { capacityId: capacity.id, state: "ACTIVE" } }),
      ).toBe(0);
      const interruptedRepair = startWorker({ operation: "reclaim", limit: 10 });
      children.add(interruptedRepair.child);
      await expect(interruptedRepair.result).resolves.toEqual({ reclaimed: 0 });
      expect(upstreamRequests).toBe(3);

      await db.executionTarget.update({
        where: { id: target.id },
        data: { directPriority: 0 },
      });
      const highModel = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          upstreamModelId: `high-${suffix}`,
        },
      });
      const highTarget = await db.executionTarget.create({
        data: {
          userId: owner.id,
          kind: "PROVIDER_MODEL",
          providerModelId: highModel.id,
          inferenceCapacityId: capacity.id,
          directPriority: 31,
        },
      });
      const queueAttempt = (label: string, executionTargetId: string) => ({
        ...attempt(label),
        candidates: [{ capacityId: capacity.id, executionTargetId, candidateOrder: 0 }],
      });
      const blocker = queueAttempt("wdrr-blocker", target.id);
      const blockerResponse = await fetch(`http://127.0.0.1:${ports[0]}/admit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(blocker),
      });
      expect(blockerResponse.status).toBe(200);
      const lowAttempts = [
        queueAttempt("wdrr-low-head", target.id),
        queueAttempt("wdrr-low-second", target.id),
      ];
      const highAttempts = Array.from({ length: 40 }, (_value, index) =>
        queueAttempt(`wdrr-high-${index}`, highTarget.id),
      );
      for (const [index, queued] of [...lowAttempts, ...highAttempts].entries()) {
        const response = await fetch(`http://127.0.0.1:${ports[index % 2]}/admit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(queued),
        });
        expect(response.status).toBe(202);
      }
      await db.inferenceCapacity.update({
        where: { id: capacity.id },
        data: { schedulerCursor: 0, schedulerDeficits: Array(32).fill(0) },
      });
      const blockerRelease = await fetch(
        `http://127.0.0.1:${ports[0]}/release/${blocker.attemptId}`,
        { method: "POST" },
      );
      expect(await blockerRelease.json()).toEqual({ released: true });

      const winners: string[] = [];
      for (let round = 0; round < 36; round++) {
        const active = await waitFor(() =>
          db.capacityLease
            .findFirst({
              where: { capacityId: capacity.id, state: "ACTIVE" },
              orderBy: { createdAt: "desc" },
            })
            .then((row) => row ?? undefined),
        );
        winners.push(active.attemptId);
        const serializable = {
          leaseId: active.id,
          attemptId: active.attemptId,
          capacityId: active.capacityId,
          executionTargetId: active.executionTargetId,
          poolMemberId: active.poolMemberId ?? undefined,
          fencingToken: active.fencingToken.toString(),
          expiresAt: active.expiresAt.toISOString(),
          reservationClass: active.reservationClass,
          borrowed: active.borrowed,
        };
        const response = await fetch(`http://127.0.0.1:${ports[round % 2]}/release-lease`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(serializable),
        });
        expect(await response.json()).toEqual({ released: true });
        if (round === 10) {
          await stop(servers[0]!.child);
          children.delete(servers[0]!.child);
          const restarted = startWorker({ operation: "server", upstreamUrl });
          children.add(restarted.child);
          const ready = await restarted.result;
          if (!("port" in ready)) throw new Error("Contended worker restart failed.");
          ports[0] = ready.port;
          servers[0] = restarted;
        }
      }
      expect(winners[0]).toBe(lowAttempts[0]!.attemptId);
      const secondLowRound = winners.indexOf(lowAttempts[1]!.attemptId);
      expect(secondLowRound).toBeGreaterThan(0);
      expect(secondLowRound).toBeLessThanOrEqual(33);
      expect(winners.filter((winner) => winner.includes("wdrr-high-")).length).toBeGreaterThan(
        winners.filter((winner) => winner.includes("wdrr-low-")).length,
      );
      expect(new Set(winners).size).toBe(winners.length);
    } finally {
      for (const server of servers) await stop(server.child);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  }, 90_000);
});
