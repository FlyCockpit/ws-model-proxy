import path from "node:path";

import { loadRootDotenv } from "@ws-model-proxy/env/root-dotenv";
import { defineConfig } from "prisma/config";

// Explicit call (not a side-effect import) so this file can keep defineConfig
// as the default export. Resolves the monorepo root via pnpm-workspace.yaml;
// existing process.env values win when set externally.
loadRootDotenv();

// Shadow database for `prisma migrate diff --from-migrations` (the
// `pnpm db:migrate` generator and the consistency check). Derived, never a
// separate env var: `<database>_shadow` next to DATABASE_URL — the same
// derivation scripts/assert-local-database.sh validates and `pnpm db:worktree`
// provisions. Prisma wipes this database on every diff, so the wrappers only
// run it after that guard accepted the exact local name. `migrate deploy`
// (production) never touches it.
function shadowDatabaseUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!database) return undefined;
    parsed.pathname = `/${encodeURIComponent(`${database}_shadow`)}`;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
    shadowDatabaseUrl: shadowDatabaseUrl(process.env.DATABASE_URL),
  },
});
