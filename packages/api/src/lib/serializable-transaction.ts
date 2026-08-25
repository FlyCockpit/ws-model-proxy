import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";

const RETRYABLE_CODES = new Set(["P2034", "40001", "40P01"]);

function databaseCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export async function runSerializableTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!RETRYABLE_CODES.has(databaseCode(error) ?? "")) throw error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw new ORPCError("CONFLICT", {
    message: "Configuration changed concurrently. Retry the request.",
  });
}
