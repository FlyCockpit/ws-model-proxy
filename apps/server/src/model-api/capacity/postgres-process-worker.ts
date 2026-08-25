import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { PostgresCapacityAdmissionStore } from "./postgres-store.js";
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
  | { operation: "reclaim"; limit: number };

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
      await new Promise<never>(() => undefined);
    }
  } else if (command.operation === "release") {
    write({
      released: await store.release({
        ...command.lease,
        fencingToken: BigInt(command.lease.fencingToken),
        expiresAt: new Date(command.lease.expiresAt),
      }),
    });
  } else {
    write({ reclaimed: await store.reclaimExpired(new Date(), command.limit) });
  }
} finally {
  await db.$disconnect();
}
