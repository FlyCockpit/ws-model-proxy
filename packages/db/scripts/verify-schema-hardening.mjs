import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const sql = await readFile(sqlPath, "utf8");

const requiredFragments = [
  "execution_target_kind_source_xor_check",
  "pg_get_constraintdef",
  "ON CONFLICT (\"discoveredModelId\") DO NOTHING",
  "UPDATE pool_member",
  "UPDATE model_api_token_allowlist_entry",
  "UPDATE response_stickiness_record",
  "UPDATE relay_request",
];

for (const fragment of requiredFragments) {
  if (!sql.includes(fragment)) {
    throw new Error(`schema-hardening.sql is missing required fragment: ${fragment}`);
  }
}

process.stdout.write("Schema-hardening source validation complete.\n");
