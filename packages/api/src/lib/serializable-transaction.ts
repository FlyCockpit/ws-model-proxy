import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";

const RETRYABLE_CODES = new Set(["P2034", "40001", "40P01"]);

function stringProperty(value: unknown, property: string): string | undefined {
  if (!value || typeof value !== "object" || !(property in value)) return undefined;
  const propertyValue = Reflect.get(value, property);
  return typeof propertyValue === "string" ? propertyValue : undefined;
}

/**
 * Prisma wraps database errors raised by raw queries in P2010 and preserves
 * the PostgreSQL SQLSTATE in `meta.code`. Normal Prisma serialization errors
 * expose P2034 directly, while some drivers expose the SQLSTATE directly.
 */
export function retryableSerializableTransactionCode(error: unknown): string | undefined {
  const code = stringProperty(error, "code");
  if (code === "P2010") {
    if (!error || typeof error !== "object" || !("meta" in error)) return undefined;
    const sqlState = stringProperty(Reflect.get(error, "meta"), "code");
    return sqlState && RETRYABLE_CODES.has(sqlState) ? sqlState : undefined;
  }
  return code && RETRYABLE_CODES.has(code) ? code : undefined;
}

export async function runSerializableTransaction<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: "Serializable",
      });
    } catch (error) {
      if (!retryableSerializableTransactionCode(error)) throw error;
      if (attempt === 4) break;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  throw new ORPCError("CONFLICT", {
    message: "Configuration changed concurrently. Retry the request.",
  });
}
