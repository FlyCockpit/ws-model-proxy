import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  encryptProviderCredential,
  parseProviderCredentialKeyring,
} from "@ws-model-proxy/api/lib/provider-credential-crypto";
import { poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
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
  | { budgets: number; attempts: number }
  | { winner?: { admissionRequestId: string; priority: number } }
  | { port: number };

function startWorker(command: unknown) {
  const production =
    typeof command === "object" &&
    command !== null &&
    "operation" in command &&
    command.operation === "production-server";
  const applicationName = production ? `wsmp-prod-${crypto.randomUUID()}` : undefined;
  const workerDatabaseUrl =
    applicationName && databaseUrl
      ? `${databaseUrl}${databaseUrl.includes("?") ? "&" : "?"}application_name=${encodeURIComponent(applicationName)}`
      : databaseUrl;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", workerPath, Buffer.from(JSON.stringify(command)).toString("base64url")],
    {
      cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
      env: {
        ...process.env,
        DATABASE_URL: workerDatabaseUrl,
        SCHEMA_VALIDATION_DATABASE_URL: workerDatabaseUrl,
      },
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
  return { child, result, applicationName };
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
        endpointIdentity: "https://example.test",
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
        UPDATE capacity_lease SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
         WHERE id = ${holderResult.lease.leaseId}`;
      const sweepers = [
        startWorker({ operation: "reclaim", limit: 10 }),
        startWorker({ operation: "reclaim", limit: 10 }),
      ];
      for (const sweeper of sweepers) children.add(sweeper.child);
      const sweepResults = await Promise.all(sweepers.map((sweeper) => sweeper.result));
      // Reclaim is deliberately global. Another concurrently running
      // integration sweeper may win this lease, so the durable row below—not
      // this worker-local count—is the authoritative ownership proof.
      expect(
        sweepResults.every((result) => "reclaimed" in result && Number.isInteger(result.reclaimed)),
      ).toBe(true);
      await expect(
        db.capacityLease.findUniqueOrThrow({ where: { id: holderResult.lease.leaseId } }),
      ).resolves.toMatchObject({ state: "RECLAIMED" });

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

    await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
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
        endpointIdentity: "https://example.test",
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
        const workOutcome = fetch(`http://127.0.0.1:${ports[0]}/work`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(holderAttempt),
        }).then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
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
          const outcome = await workOutcome;
          if (!outcome.response) throw outcome.error;
          const response = outcome.response;
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
        if (phase === "precommit") {
          const outcome = await workOutcome;
          expect(outcome.response).toBeUndefined();
          expect(outcome.error).toBeDefined();
        }
        upstreamResponse.destroy();
        await db.$executeRaw`
          UPDATE capacity_lease SET "expiresAt" = clock_timestamp() - interval '1 millisecond'
           WHERE id = ${oldLease.id}`;
        const reclaim = startWorker({ operation: "reclaim", limit: 10 });
        children.add(reclaim.child);
        // Other integration files can have expired work in the same forced-PG
        // run. The global sweeper count is therefore not scoped to this lease;
        // successful recovery below proves this exact lease was reclaimed.
        await expect(reclaim.result).resolves.toMatchObject({
          reclaimed: expect.any(Number),
        });
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
        const duplicateKilledAttempt = startWorker({
          operation: "acquire",
          attempt: { ...holderAttempt, candidates: [] },
          hold: false,
        });
        children.add(staleHeartbeat.child);
        children.add(staleRelease.child);
        children.add(duplicateKilledAttempt.child);
        await expect(staleHeartbeat.result).resolves.toEqual({ heartbeat: false });
        await expect(staleRelease.result).resolves.toEqual({ released: false });
        await expect(duplicateKilledAttempt.result).resolves.toEqual({ state: "CANCELLED" });
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

  it("boots production model routes in two processes and preserves commit semantics", async () => {
    if (!db || !databaseUrl) return;
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED = "true";
    process.env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS = "true";
    process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS = `process-v1:${Buffer.alloc(32, 37).toString("base64")}`;
    process.env.MODEL_API_GLOBAL_CAPACITY_ENABLED = "true";
    process.env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED = "true";
    const { credentialLookupPrefix, hmacDigestForForwarderPurpose } = await import(
      "@ws-model-proxy/db/forwarder-security"
    );
    const upstreamResponses: Array<{ path: string; response: ServerResponse }> = [];
    const observations: string[] = [];
    const upstream = createServer((request, response) => {
      const path = request.url ?? "";
      observations.push(path);
      upstreamResponses.push({ path, response });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Production upstream unavailable.");
    const origin = `http://127.0.0.1:${address.port}`;
    const suffix = crypto.randomUUID();
    const owner = await db.user.create({
      data: {
        name: "Production process proof",
        email: `production-process-${suffix}@example.test`,
        slug: `production-process-${suffix}`,
      },
    });
    const capacity = await db.inferenceCapacity.create({
      data: {
        userId: owner.id,
        label: `production-capacity-${suffix}`,
        runtimeIdentityKey: `production-runtime-${suffix}`,
        runtimeModel: "production-proof",
        hardConcurrencyLimit: 1,
      },
    });
    const pool = await db.modelPool.create({
      data: {
        userId: owner.id,
        slug: `production-pool-${suffix}`,
        name: "Production process pool",
        protocolAdaptationEnabled: true,
        publicEgressEnabled: true,
        publicEgressAcknowledged: true,
      },
    });
    const keyring = parseProviderCredentialKeyring(
      process.env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
    );
    const createProvider = async (label: string, publicOrder: number) => {
      const accountId = crypto.randomUUID();
      const credentialId = crypto.randomUUID();
      const account = await db.providerAccount.create({
        data: {
          id: accountId,
          userId: owner.id,
          providerType: "openai",
          label: `${label}-${suffix}`,
          baseUrl: `${origin}/${label}`,
          endpointIdentity: `${origin}/${label}`,
          authType: "BEARER",
          status: "ACTIVE",
          enabled: false,
          healthStatus: "HEALTHY",
        },
      });
      const encrypted = encryptProviderCredential(
        `secret-${label}`,
        {
          userId: owner.id,
          providerAccountId: account.id,
          credentialId,
          credentialType: "BEARER",
          aadVersion: 1,
        },
        keyring,
      );
      await db.$transaction(async (tx) => {
        await tx.providerCredential.create({
          data: {
            id: credentialId,
            userId: owner.id,
            providerAccountId: account.id,
            credentialType: "BEARER",
            ...encrypted,
          },
        });
        await tx.providerAccount.update({
          where: { id: account.id },
          data: { currentCredentialId: credentialId, enabled: true },
        });
      });
      const model = await db.providerModel.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          upstreamModelId: `upstream-${label}`,
          enabled: true,
          healthStatus: "HEALTHY",
          contextWindow: 8_192,
          maxOutputTokens: 256,
          nativeCapabilities: {
            protocols: ["openai"],
            surfaces: ["openai-chat"],
            streaming: true,
            features: [],
          },
        },
      });
      const target = await db.executionTarget.create({
        data: {
          userId: owner.id,
          kind: "PROVIDER_MODEL",
          providerModelId: model.id,
          inferenceCapacityId: capacity.id,
        },
      });
      await db.poolMember.create({
        data: {
          poolId: pool.id,
          executionTargetId: target.id,
          tier: "PUBLIC_OVERFLOW",
          publicOrder,
        },
      });
      await db.providerPricingVersion.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          version: "process-v1",
          currency: "USD",
          status: "ACTIVE",
          accountingVersion: "provider-billable-v1",
          confidence: "CALCULATED",
          effectiveAt: new Date(Date.now() - 60_000),
          activatedAt: new Date(Date.now() - 60_000),
          pricing: { ratesPerMillion: { input: "1", output: "2", additional: "2" } },
          chargeRules: {
            inputIncludesCacheRead: false,
            inputIncludesCacheWrite: false,
            outputIncludesReasoning: false,
            outputIncludesTool: false,
            cacheReadAllowanceTokens: 0,
            cacheWriteAllowanceTokens: 0,
            reasoningAllowanceTokens: 0,
            toolAllowanceTokens: 0,
            additionalAllowanceTokens: 0,
            unknownCategories: "FAIL_CLOSED",
          },
        },
      });
      await db.providerBudgetPolicy.create({
        data: {
          userId: owner.id,
          providerAccountId: account.id,
          providerModelId: model.id,
          poolId: pool.id,
          scopeType: "POOL_PROVIDER_MODEL",
          active: true,
          activatedAt: new Date(Date.now() - 60_000),
          Rules: {
            create: [
              { metric: "CONCURRENCY", period: "PER_ATTEMPT", mode: "UNLIMITED" },
              { metric: "TOKENS", period: "UTC_DAY", mode: "LIMITED", limitValue: 100_000 },
              {
                metric: "SPEND",
                period: "UTC_DAY",
                mode: "LIMITED",
                limitValue: "10",
                currency: "USD",
              },
            ],
          },
        },
      });
      return { account, model, target };
    };
    const primary = await createProvider("primary", 0);
    await createProvider("secondary", 1);
    const rawToken = `wsmp_model_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.modelApiToken.create({
      data: {
        userId: owner.id,
        name: "Production process token",
        lookupPrefix: credentialLookupPrefix(rawToken),
        secretDigest: hmacDigestForForwarderPurpose({ purpose: "modelApiToken", value: rawToken }),
      },
    });
    const modelId = poolModelId({ userSlug: owner.slug, poolSlug: pool.slug });
    const request = (port: number) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          stream: true,
          max_tokens: 16,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    const workers = [
      startWorker({ operation: "production-server" }),
      startWorker({ operation: "production-server" }),
    ];
    for (const worker of workers) children.add(worker.child);
    const ready = await Promise.all(workers.map((worker) => worker.result));
    const ports = ready.map((result) => {
      if (!("port" in result)) throw new Error("Production worker did not become ready.");
      return result.port;
    });
    try {
      let priorProviderFence = 0n;
      for (const phase of ["before-byte", "after-byte"] as const) {
        const observationStart = observations.length;
        const responsePromise = request(ports[0]!);
        const responseOutcome = responsePromise.then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
        let upstreamObserved = false;
        const controlled = await Promise.race([
          waitFor(() => upstreamResponses.shift(), 10_000).then((upstreamResponse) => {
            upstreamObserved = true;
            return upstreamResponse;
          }),
          responseOutcome.then(async (outcome) => {
            if (upstreamObserved) return new Promise<never>(() => undefined);
            if (!outcome.response)
              throw outcome.error ?? new Error("Production route failed without an error.");
            const body = await outcome.response.text();
            throw new Error(
              `Production route returned before upstream dispatch: ${outcome.response.status} ${body}`,
            );
          }),
        ]);
        expect(controlled.path).toContain("/primary/");
        if (phase === "after-byte") {
          controlled.response.writeHead(200, { "content-type": "text/event-stream" });
          controlled.response.write(
            `data: ${JSON.stringify({
              id: `chunk-${suffix}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "upstream-primary",
              choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }],
            })}\n\n`,
          );
          const outcome = await responseOutcome;
          if (!outcome.response) throw outcome.error;
          const downstream = outcome.response;
          const first = await downstream.body?.getReader().read();
          expect(new TextDecoder().decode(first?.value)).toContain("first");
        }
        const active = await waitFor(() =>
          db.providerAttempt
            .findFirst({
              where: { providerModelId: primary.model.id, state: "ACTIVE" },
              orderBy: { createdAt: "desc" },
            })
            .then((attemptRow) => attemptRow ?? undefined),
        );
        expect(active.fencingToken).toBeGreaterThan(priorProviderFence);
        priorProviderFence = active.fencingToken;
        await stop(workers[0]!.child);
        children.delete(workers[0]!.child);
        if (phase === "before-byte") {
          const outcome = await responseOutcome;
          expect(outcome.error).toBeDefined();
          expect(outcome.response).toBeUndefined();
        }
        controlled.response.destroy();
        expect(
          observations.slice(observationStart).filter((path) => path.includes("/secondary/")),
        ).toHaveLength(0);
        await db.providerAttempt.update({
          where: { id: active.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
        const providerRepair = startWorker({
          operation: "repair-provider",
          now: new Date(Date.now() + 10 * 60_000).toISOString(),
          userId: owner.id,
          providerAccountId: primary.account.id,
        });
        children.add(providerRepair.child);
        const providerRepairResult = await providerRepair.result;
        expect(providerRepairResult).toMatchObject({ budgets: 1 });
        const duplicateProviderRepair = startWorker({
          operation: "repair-provider",
          now: new Date(Date.now() + 10 * 60_000).toISOString(),
          userId: owner.id,
          providerAccountId: primary.account.id,
        });
        children.add(duplicateProviderRepair.child);
        await expect(duplicateProviderRepair.result).resolves.toMatchObject({ budgets: 0 });
        await expect(
          db.providerAttempt.findFirstOrThrow({
            where: { providerModelId: primary.model.id },
            orderBy: { createdAt: "desc" },
          }),
        ).resolves.toMatchObject({ state: "EXPIRED", terminalReason: "CRASH_RECOVERY" });
        expect(
          await db.providerAttempt.count({
            where: { providerModelId: primary.model.id, state: "ACTIVE" },
          }),
        ).toBe(0);
        const restarted = startWorker({ operation: "production-server" });
        children.add(restarted.child);
        const restartedResult = await restarted.result;
        if (!("port" in restartedResult)) throw new Error("Production restart failed.");
        workers[0] = restarted;
        ports[0] = restartedResult.port;
      }

      const interruptedOutcome = request(ports[0]!).then(
        (response) => ({ response, error: undefined }),
        (error: unknown) => ({ response: undefined, error }),
      );
      const controlled = await waitFor(() => upstreamResponses.shift(), 10_000);
      const selectedApplicationName = workers[0]!.applicationName;
      if (!selectedApplicationName) throw new Error("Production worker application name missing.");
      const backendRows = await waitFor(() =>
        db.$queryRaw<Array<{ pid: number }>>`
        SELECT pid FROM pg_stat_activity
         WHERE application_name = ${selectedApplicationName}
           AND pid <> pg_backend_pid()`.then((rows) => (rows.length > 0 ? rows : undefined)),
      );
      const selectedBackendPids = backendRows.map((row) => row.pid);
      expect(selectedBackendPids.length).toBeGreaterThan(0);
      const terminated = await Promise.all(
        selectedBackendPids.map(
          (pid) =>
            db.$queryRaw<Array<{ terminated: boolean }>>`
            SELECT pg_terminate_backend(${pid}) AS terminated`,
        ),
      );
      expect(terminated).toEqual(selectedBackendPids.map(() => [{ terminated: true }]));
      await waitFor(async () => {
        const presence = await Promise.all(
          selectedBackendPids.map(
            (pid) =>
              db.$queryRaw<Array<{ present: boolean }>>`
              SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}) AS present`,
          ),
        );
        return presence.every((rows) => rows[0]?.present === false) ? true : undefined;
      });
      controlled.response.destroy(new Error("database connectivity interruption"));
      const fallback = await waitFor(
        () => upstreamResponses.find((entry) => entry.path.includes("/secondary/")),
        10_000,
      );
      const recoveredBackendRows = await waitFor(() =>
        db.$queryRaw<Array<{ pid: number }>>`
          SELECT pid FROM pg_stat_activity
           WHERE application_name = ${selectedApplicationName}
             AND pid <> pg_backend_pid()`.then((rows) => {
          const recovered = rows.filter((row) => !selectedBackendPids.includes(row.pid));
          return recovered.length > 0 ? recovered : undefined;
        }),
      );
      expect(recoveredBackendRows.every((row) => !selectedBackendPids.includes(row.pid))).toBe(
        true,
      );
      fallback.response.writeHead(503, { "content-type": "application/json" });
      fallback.response.end(JSON.stringify({ error: { message: "controlled fallback failure" } }));
      const interrupted = await interruptedOutcome;
      if (!interrupted.response) throw interrupted.error;
      expect(interrupted.response.status).toBeGreaterThanOrEqual(400);
      const interruptedLease = await db.providerAttempt.findFirst({
        where: { providerModelId: primary.model.id },
        orderBy: { createdAt: "desc" },
      });
      if (interruptedLease?.state === "ACTIVE") {
        await db.providerAttempt.update({
          where: { id: interruptedLease.id },
          data: { expiresAt: new Date(Date.now() - 1) },
        });
      }
      const interruptedProviderRepair = startWorker({
        operation: "repair-provider",
        now: new Date(Date.now() + 10 * 60_000).toISOString(),
        userId: owner.id,
        providerAccountId: primary.account.id,
      });
      children.add(interruptedProviderRepair.child);
      await expect(interruptedProviderRepair.result).resolves.toMatchObject({
        budgets: expect.any(Number),
      });
      expect(
        await db.providerAttempt.count({
          where: { providerModelId: primary.model.id, state: "ACTIVE" },
        }),
      ).toBe(0);
      expect(await db.providerAttempt.count({ where: { providerModelId: primary.model.id } })).toBe(
        3,
      );
    } finally {
      for (const worker of workers) await stop(worker.child);
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await db.user.delete({ where: { id: owner.id } }).catch(() => undefined);
    }
  }, 120_000);
});
