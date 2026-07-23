import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

// ---------------------------------------------------------------------------
// Pure helpers for resolving and loading the monorepo root `.env`.
//
// No import-time side effects — safe to unit-test and to call explicitly from
// configs that need a default export of their own (e.g. prisma.config.ts).
//
// Process entrypoints that only need the load can instead side-effect import:
//   import "@ws-model-proxy/env/load-dotenv";
// ---------------------------------------------------------------------------

/** Walk parents looking for the monorepo root (`pnpm-workspace.yaml`). */
export function findRepoRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the canonical root `.env` path.
 *
 * Prefers a workspace root found from `moduleDir`, then from `cwd`, then
 * falls back to `cwd/.env` for launches outside a recognizable monorepo layout.
 */
export function resolveRootEnvPath(options?: { moduleDir?: string; cwd?: string }): string {
  const moduleDir = options?.moduleDir ?? import.meta.dirname;
  const cwd = options?.cwd ?? process.cwd();

  const fromModule = findRepoRoot(moduleDir);
  if (fromModule) return path.join(fromModule, ".env");

  const fromCwd = findRepoRoot(cwd);
  if (fromCwd) return path.join(fromCwd, ".env");

  // Last resort: CWD (matches common `node` / `tsx` launches from the repo root).
  return path.resolve(cwd, ".env");
}

/** Load the root `.env` into `process.env` (existing keys win). */
export function loadRootDotenv(options?: { moduleDir?: string; cwd?: string }): string {
  const rootEnvPath = resolveRootEnvPath(options);
  // quiet: suppress dotenv's tip banners (tests / many entrypoints load this).
  loadEnv({ path: rootEnvPath, quiet: true });
  return rootEnvPath;
}

/** Warn if a legacy per-app env file still exists under apps/server. */
export function warnIfStaleServerEnv(options?: { moduleDir?: string; cwd?: string }): void {
  const moduleDir = options?.moduleDir ?? import.meta.dirname;
  const cwd = options?.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(moduleDir) ?? findRepoRoot(cwd);
  if (!repoRoot) return;

  const staleEnvPath = path.join(repoRoot, "apps/server/.env");
  if (fs.existsSync(staleEnvPath)) {
    console.warn(
      "[env] Found apps/server/.env — this file is no longer read. " +
        "The canonical .env location is the repository root. " +
        "Move its contents to the root .env and delete apps/server/.env to silence this warning.",
    );
  }
}
