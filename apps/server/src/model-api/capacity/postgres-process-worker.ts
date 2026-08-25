import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
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
  } else if (command.operation === "reclaim") {
    write({ reclaimed: await store.reclaimExpired(new Date(), command.limit) });
  } else {
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
  }
} finally {
  await db.$disconnect();
}
