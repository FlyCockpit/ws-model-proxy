import prisma from "@ws-model-proxy/db";

const NOT_BACKFILLED =
  "Database has rows from WS Model Proxy 0.4.x that the 1.0 schema backfill has not converted. Deploy once with APPLY_SCHEMA=safe (see UPGRADING.md).";
const NO_SCHEMA =
  "The database has no WS Model Proxy schema yet. Deploy once with APPLY_SCHEMA=safe to create it (see UPGRADING.md).";

/** Postgres `undefined_table`, raised through Prisma's raw-query error. */
function isUndefinedTable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const meta: unknown = Reflect.get(error, "meta");
  const code = typeof meta === "object" && meta !== null ? Reflect.get(meta, "code") : undefined;
  return code === "42P01" || /relation "[^"]+" does not exist/.test(String(error));
}

/** Refuse traffic until the 1.0 schema backfill has converted all persisted legacy rows. */
export async function assertDatabaseBackfilled(): Promise<void> {
  const [rows] = await queryLegacyRows();
  if (!rows || rows.instances || rows.capabilities) {
    throw new Error(NOT_BACKFILLED);
  }
}

async function queryLegacyRows() {
  try {
    return await readLegacyRows();
  } catch (error) {
    if (isUndefinedTable(error)) throw new Error(NO_SCHEMA, { cause: error });
    throw error;
  }
}

function readLegacyRows() {
  return prisma.$queryRaw<Array<{ instances: boolean; capabilities: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM runtime_instance WHERE "runGeneration" < 1
    ) AS instances, EXISTS (
      SELECT 1 FROM provider_model
      WHERE (jsonb_typeof("capabilityMetadata") = 'object' AND (
        "capabilityMetadata" ? 'completions'
        OR (jsonb_typeof("capabilityMetadata" -> 'surfaces') = 'object'
          AND "capabilityMetadata" -> 'surfaces' ? 'openaiCompletions')
      )) OR (jsonb_typeof("nativeCapabilities") = 'object' AND (
        "nativeCapabilities" ? 'completions'
        OR (jsonb_typeof("nativeCapabilities" -> 'surfaces') = 'object'
          AND "nativeCapabilities" -> 'surfaces' ? 'openaiCompletions')
      ))
    ) AS capabilities`;
}
