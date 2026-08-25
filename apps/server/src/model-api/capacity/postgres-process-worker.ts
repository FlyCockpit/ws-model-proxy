import { serve } from "@hono/node-server";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { Hono } from "hono";
import { PostgresCapacityAdmissionStore } from "./postgres-store.js";
import { PRIORITY_CLASS_COUNT, scheduleWeightedDeficitRoundRobin } from "./scheduler.js";
import type { AdmissionAttempt, CapacityLeaseHandle } from "./types.js";

type WorkerCommand =
  | {
      operation: "acquire";
      attempt: Omit<AdmissionAttempt, "deadlineAt"> & { deadlineAt: string };
      hold: boolean;
    }
  | {
      operation: "release";
      lease: Omit<CapacityLeaseHandle, "fencingToken" | "expiresAt"> & {
        fencingToken: string;
        expiresAt: string;
      };
    }
  | {
      operation: "heartbeat";
      extensionMs: number;
      lease: Omit<CapacityLeaseHandle, "fencingToken" | "expiresAt"> & {
        fencingToken: string;
        expiresAt: string;
      };
    }
  | { operation: "reclaim"; limit: number }
  | {
      operation: "schedule";
      capacityId: string;
      candidates: Array<{
        admissionRequestId: string;
        waiterId: string;
        candidateOrder: number;
        priority: number;
        enqueueSequence: string;
        eligible: boolean;
      }>;
    }
  | {
      operation: "server";
      upstreamUrl: string;
    };

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (!databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required by the process worker.");
const encoded = process.argv[2];
if (!encoded) throw new Error("A base64url worker command is required.");
const command = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as WorkerCommand;
const db = createPrismaClient(databaseUrl);
const store = new PostgresCapacityAdmissionStore(db, `process-worker-${process.pid}`);

const write = (value: unknown) =>
  process.stdout.write(
    `${JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))}\n`,
  );

try {
  if (command.operation === "acquire") {
    const result = await store.acquire({
      ...command.attempt,
      deadlineAt: new Date(command.attempt.deadlineAt),
    });
    write(result);
    if (command.hold && result.state === "ADMITTED") {
      // The parent deliberately SIGKILLs this process to model a server dying
      // after admission (including while a response stream owns the lease).
      await new Promise<never>(() => setInterval(() => undefined, 60_000));
    }
  } else if (command.operation === "release") {
    write({
      released: await store.release({
        ...command.lease,
        fencingToken: BigInt(command.lease.fencingToken),
        expiresAt: new Date(command.lease.expiresAt),
      }),
    });
  } else if (command.operation === "heartbeat") {
    write({
      heartbeat: await store.heartbeat(
        {
          ...command.lease,
          fencingToken: BigInt(command.lease.fencingToken),
          expiresAt: new Date(command.lease.expiresAt),
        },
        command.extensionMs,
      ),
    });
  } else if (command.operation === "reclaim") {
    write({ reclaimed: await store.reclaimExpired(new Date(), command.limit) });
  } else if (command.operation === "schedule") {
    const winner = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${command.capacityId}, 0))`;
      const capacity = await tx.inferenceCapacity.findUniqueOrThrow({
        where: { id: command.capacityId },
      });
      const deficits =
        Array.isArray(capacity.schedulerDeficits) &&
        capacity.schedulerDeficits.length === PRIORITY_CLASS_COUNT
          ? capacity.schedulerDeficits.map((value) => (typeof value === "number" ? value : 0))
          : Array(PRIORITY_CLASS_COUNT).fill(0);
      const decision = scheduleWeightedDeficitRoundRobin({
        state: {
          cursor: capacity.schedulerCursor,
          deficits,
          version: capacity.schedulerVersion,
        },
        candidates: command.candidates.map((candidate) => ({
          ...candidate,
          enqueueSequence: BigInt(candidate.enqueueSequence),
        })),
      });
      await tx.inferenceCapacity.update({
        where: { id: command.capacityId },
        data: {
          schedulerCursor: decision.state.cursor,
          schedulerDeficits: decision.state.deficits,
          schedulerVersion: decision.state.version,
        },
      });
      return decision.winner;
    });
    write({ winner });
  } else {
    const app = new Hono();
    const leases = new Map<string, CapacityLeaseHandle>();
    app.post("/admit", async (context) => {
      const input = (await context.req.json()) as Omit<AdmissionAttempt, "deadlineAt"> & {
        deadlineAt: string;
      };
      const result = await store.acquire({ ...input, deadlineAt: new Date(input.deadlineAt) });
      if (result.state === "ADMITTED") leases.set(input.attemptId, result.lease);
      return context.json(result, result.state === "ADMITTED" ? 200 : 202);
    });
    app.post("/release/:attemptId", async (context) => {
      const lease = leases.get(context.req.param("attemptId"));
      if (!lease) return context.json({ released: false }, 404);
      const released = await store.release(lease);
      if (released) leases.delete(lease.attemptId);
      return context.json({ released });
    });
    app.post("/release-lease", async (context) => {
      const input = (await context.req.json()) as Omit<
        CapacityLeaseHandle,
        "fencingToken" | "expiresAt"
      > & { fencingToken: string; expiresAt: string };
      const released = await store.release({
        ...input,
        fencingToken: BigInt(input.fencingToken),
        expiresAt: new Date(input.expiresAt),
      });
      return context.json({ released });
    });
    app.post("/work", async (context) => {
      const input = (await context.req.json()) as Omit<AdmissionAttempt, "deadlineAt"> & {
        deadlineAt: string;
      };
      const result = await store.acquire({ ...input, deadlineAt: new Date(input.deadlineAt) });
      if (result.state !== "ADMITTED") return context.json(result, 503);
      const heartbeat = setInterval(() => void store.heartbeat(result.lease, 30_000), 50);
      let upstream: Response;
      try {
        upstream = await fetch(command.upstreamUrl);
      } catch (error) {
        clearInterval(heartbeat);
        await store.release(result.lease);
        throw error;
      }
      if (!upstream.body) {
        clearInterval(heartbeat);
        await store.release(result.lease);
        return new Response(null, { status: upstream.status });
      }
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              clearInterval(heartbeat);
              await store.release(result.lease);
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            clearInterval(heartbeat);
            await store.release(result.lease);
            controller.error(error);
          }
        },
        async cancel() {
          clearInterval(heartbeat);
          await reader.cancel().catch(() => undefined);
          await store.release(result.lease);
        },
      });
      return new Response(stream, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
          "x-capacity-fence": result.lease.fencingToken.toString(),
        },
      });
    });
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => write({ port: info.port }));
    await new Promise<void>((resolve) => {
      const shutdown = () => server.close(() => resolve());
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  }
} finally {
  await db.$disconnect();
}
