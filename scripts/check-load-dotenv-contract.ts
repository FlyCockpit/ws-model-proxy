import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Ensures every process entrypoint that can import env validation also loads
 * the root `.env` via the shared helpers:
 *   - side-effect: `import "@ws-model-proxy/env/load-dotenv"`
 *   - explicit:    `loadRootDotenv()` from `@ws-model-proxy/env/root-dotenv`
 *
 * When adding a new Node process entry (server boot, CLI, script, Vite config,
 * Prisma config, test setup), add it here. Do not reintroduce dotenv side
 * effects into packages/env validation modules.
 */

type Check =
  | {
      kind: "contains";
      label: string;
      file: string;
      needle: string;
    }
  | {
      kind: "vitest-setup";
      label: string;
      file: string;
    };

const LOAD_DOTENV = "@ws-model-proxy/env/load-dotenv";
const ROOT_DOTENV = "@ws-model-proxy/env/root-dotenv";

const checks: Check[] = [
  {
    kind: "contains",
    label: "API/server process entry must load root .env",
    file: "apps/server/src/index.ts",
    needle: LOAD_DOTENV,
  },
  {
    kind: "contains",
    label: "web Vite process entry must load root .env (local SSR)",
    file: "apps/web/vite.config.ts",
    needle: LOAD_DOTENV,
  },
  {
    kind: "contains",
    label: "db seed CLI entry must load root .env",
    file: "packages/db/prisma/seed.cli.ts",
    needle: LOAD_DOTENV,
  },
  {
    kind: "contains",
    label: "Prisma config entry must call loadRootDotenv from root-dotenv",
    file: "packages/db/prisma.config.ts",
    needle: ROOT_DOTENV,
  },
  {
    kind: "contains",
    label: "doctor script must load root .env",
    file: "scripts/doctor.ts",
    needle: LOAD_DOTENV,
  },
  {
    kind: "contains",
    label: "locale translation script must load root .env",
    file: "scripts/translate-locale-bundles.ts",
    needle: LOAD_DOTENV,
  },
  {
    kind: "vitest-setup",
    label: "root vitest setupFiles must include load-dotenv",
    file: "vitest.config.ts",
  },
];

let failed = false;

for (const check of checks) {
  const abs = resolve(process.cwd(), check.file);
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (error) {
    failed = true;
    console.error(`[load-dotenv-contract] ${check.label}`);
    console.error(`  missing file: ${check.file}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  if (check.kind === "contains") {
    if (!source.includes(check.needle)) {
      failed = true;
      console.error(`[load-dotenv-contract] ${check.label}`);
      console.error(`  ${check.file} must import or reference \`${check.needle}\``);
    }
    continue;
  }

  // vitest-setup: setupFiles array must include the load-dotenv entry.
  const setupMatch = source.match(/setupFiles\s*:\s*\[([^\]]*)\]/s);
  if (!setupMatch?.[1].includes(LOAD_DOTENV)) {
    failed = true;
    console.error(`[load-dotenv-contract] ${check.label}`);
    console.error(`  ${check.file} must list \`${LOAD_DOTENV}\` in test.setupFiles`);
  }
}

if (failed) process.exit(1);
