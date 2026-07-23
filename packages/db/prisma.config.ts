import path from "node:path";

import { loadRootDotenv } from "@ws-model-proxy/env/root-dotenv";
import { defineConfig } from "prisma/config";

// Explicit call (not a side-effect import) so this file can keep defineConfig
// as the default export. Resolves the monorepo root via pnpm-workspace.yaml;
// existing process.env values win when set externally.
loadRootDotenv();

export default defineConfig({
  schema: path.join("prisma", "schema"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
