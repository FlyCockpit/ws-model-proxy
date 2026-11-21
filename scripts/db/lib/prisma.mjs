/**
 * Run the Prisma CLI that packages/db pins, and load `pg` from packages/db's
 * dependency closure. Works in a checkout and in the app/worker images (both
 * ship packages/db/node_modules/prisma — see the Dockerfiles).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DB_DIR = path.join(ROOT, "packages/db");
export const SCHEMA_DIR = path.join(DB_DIR, "prisma/schema");
export const MIGRATIONS_DIR = path.join(DB_DIR, "prisma/migrations");
export const FIXTURES_DIR = path.join(DB_DIR, "prisma/fixtures");
const PRISMA_CLI = path.join(DB_DIR, "node_modules/prisma/build/index.js");
const PNPM_HOISTED_MODULES = path.join(ROOT, "node_modules/.pnpm/node_modules");

/** @returns {typeof import("pg")} */
export function loadPg() {
  return createRequire(path.join(DB_DIR, "package.json"))("pg");
}

/**
 * Run `prisma <args>` with cwd packages/db.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, capture?: boolean, quiet?: boolean, timeoutMs?: number }} [options]
 *   capture → resolve with { code, stdout, stderr } instead of inheriting stdio.
 *   timeoutMs → kill the child after this long; resolves with `timedOut: true`.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut?: boolean }>}
 */
export function prisma(args, options = {}) {
  const env = {
    ...process.env,
    // The CLI is started directly (not through pnpm's .bin shim), so give it the
    // shim's module path: in the image, packages/db/node_modules/prisma is a plain
    // copy whose own dependencies (e.g. @prisma/config) live only in the virtual
    // store's hoisted node_modules.
    NODE_PATH: [PNPM_HOISTED_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    CHECKPOINT_DISABLE: "1",
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, ...args], {
      cwd: DB_DIR,
      env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timedOut } : {}) });
    });
  });
}

/**
 * Write a dependency-free Prisma config pointing at an arbitrary migrations
 * folder / database (used for the base branch's migrations in CI and for
 * scratch databases). Returns the config path for `--config`.
 * @param {{ url: string, shadowUrl?: string, migrations?: string, schema?: string }} options
 */
export function tempConfig({ url, shadowUrl, migrations = MIGRATIONS_DIR, schema = SCHEMA_DIR }) {
  const dir = mkdtempSync(path.join(tmpdir(), "wmp-prisma-"));
  const file = path.join(dir, "prisma.config.mjs");
  const config = {
    schema,
    migrations: { path: migrations },
    datasource: { url, shadowDatabaseUrl: shadowUrl },
  };
  writeFileSync(file, `export default ${JSON.stringify(config, null, 2)};\n`, { mode: 0o600 });
  return file;
}
