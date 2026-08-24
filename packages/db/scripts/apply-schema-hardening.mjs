import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to apply schema hardening");
}

const sqlPath = fileURLToPath(new URL("../prisma/schema-hardening.sql", import.meta.url));
const sql = await readFile(sqlPath, "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  process.stdout.write("Schema hardening and compatibility backfill complete.\n");
} finally {
  await client.end();
}
