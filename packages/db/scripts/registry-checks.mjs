/**
 * Generates the registry-backed CHECKs of schema-hardening.sql from the Advanced registries
 * (`packages/config/src/pool-defaults.ts`, `runtime-defaults.ts`), so the database refuses
 * exactly what the API refuses. schema-hardening.sql holds the output between the
 * `-- BEGIN GENERATED registry checks` / `-- END GENERATED registry checks` markers;
 * verify-schema-hardening.mjs fails when the block and this output differ.
 *
 *   node scripts/registry-checks.mjs --write   # refresh the block in place
 *
 * Imports the TypeScript registries directly (Node type stripping); dev/CI only.
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { POOL_ADVANCED_COLUMNS, POOL_ADVANCED_OVERRIDES } from "../../config/src/pool-defaults.ts";
import { RUNTIME_ADVANCED, RUNTIME_LIMIT_COLUMNS } from "../../config/src/runtime-defaults.ts";

export const BEGIN_MARKER = "-- BEGIN GENERATED registry checks (scripts/registry-checks.mjs)";
export const END_MARKER = "-- END GENERATED registry checks";

/** The registry without UI-only keys, as the JSON the SQL validator reads. */
function registryJson(registry) {
  const out = {};
  for (const [key, entry] of Object.entries(registry)) {
    if ("kind" in entry) {
      const { kind } = entry;
      out[key] =
        kind === "enum"
          ? { kind, values: [...entry.values] }
          : kind === "bool"
            ? { kind }
            : { kind, min: entry.min, max: entry.max };
    } else {
      out[key] = registryJson(entry);
    }
  }
  return out;
}

function sqlLiteral(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function columnCheck(column, entry) {
  const quoted = `"${column}"`;
  switch (entry.kind) {
    case "int":
    case "number":
      return `(${quoted} IS NULL OR ${quoted} BETWEEN ${entry.min} AND ${entry.max})`;
    case "enum":
      return `(${quoted}::text IN (${entry.values.map((value) => `'${value}'`).join(", ")}))`;
    case "bool":
      return "TRUE";
  }
  throw new Error(`unknown registry kind for ${column}`);
}

export function registryChecksSql() {
  const poolColumns = Object.entries(POOL_ADVANCED_COLUMNS)
    .map(([column, entry]) => columnCheck(column, entry))
    .join("\n  AND ");
  const runtimeColumns = Object.entries(RUNTIME_LIMIT_COLUMNS)
    .map(([column, entry]) => columnCheck(column, entry))
    .join("\n  AND ");
  return [
    BEGIN_MARKER,
    "ALTER TABLE pool_advanced DROP CONSTRAINT IF EXISTS pool_advanced_overrides_check;",
    "ALTER TABLE pool_advanced ADD CONSTRAINT pool_advanced_overrides_check CHECK (",
    `  wsmp_registry_ok(overrides, ${sqlLiteral(registryJson(POOL_ADVANCED_OVERRIDES))})`,
    `  AND ${poolColumns}`,
    '  AND ("contextCeiling" IS NULL OR "contextMargin" IS NULL OR "contextMargin" < "contextCeiling")',
    ");",
    "ALTER TABLE runtime_version DROP CONSTRAINT IF EXISTS runtime_version_advanced_check;",
    "ALTER TABLE runtime_version ADD CONSTRAINT runtime_version_advanced_check CHECK (",
    `  wsmp_registry_ok(advanced, ${sqlLiteral(registryJson(RUNTIME_ADVANCED))})`,
    ");",
    "ALTER TABLE runtime_version DROP CONSTRAINT IF EXISTS runtime_version_limits_check;",
    "ALTER TABLE runtime_version ADD CONSTRAINT runtime_version_limits_check CHECK (",
    `  ${runtimeColumns}`,
    ");",
    END_MARKER,
  ].join("\n");
}

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));

/** The block currently in schema-hardening.sql (null when the markers are missing). */
export function currentBlock(sql) {
  const start = sql.indexOf(BEGIN_MARKER);
  const end = sql.indexOf(END_MARKER);
  if (start < 0 || end < start) return null;
  return sql.slice(start, end + END_MARKER.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  const sql = await readFile(sqlPath, "utf8");
  const block = currentBlock(sql);
  if (block === null) throw new Error("schema-hardening.sql has no generated registry block");
  await writeFile(sqlPath, sql.replace(block, registryChecksSql()));
  process.stdout.write("Registry checks refreshed in schema-hardening.sql.\n");
}
