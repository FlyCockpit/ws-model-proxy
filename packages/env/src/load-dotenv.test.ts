import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Import pure helpers only — not ./load-dotenv, which runs side effects on import.
import { findRepoRoot, resolveRootEnvPath } from "./root-dotenv";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("findRepoRoot", () => {
  it("finds the workspace root from a nested package directory", () => {
    const root = makeTempDir("wmp-env-root-");
    const nested = path.join(root, "packages", "env", "src");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

    expect(findRepoRoot(nested)).toBe(root);
  });

  it("returns null when no pnpm-workspace.yaml exists in ancestors", () => {
    const orphan = makeTempDir("wmp-env-orphan-");
    const nested = path.join(orphan, "a", "b");
    fs.mkdirSync(nested, { recursive: true });

    expect(findRepoRoot(nested)).toBeNull();
  });
});

describe("resolveRootEnvPath", () => {
  it("prefers the monorepo root discovered from moduleDir", () => {
    const root = makeTempDir("wmp-env-mod-");
    const moduleDir = path.join(root, "packages", "env", "src");
    const otherRoot = makeTempDir("wmp-env-cwd-");
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    fs.writeFileSync(path.join(otherRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

    expect(resolveRootEnvPath({ moduleDir, cwd: otherRoot })).toBe(path.join(root, ".env"));
  });

  it("falls back to a monorepo root discovered from cwd", () => {
    const root = makeTempDir("wmp-env-cwd-root-");
    const moduleDir = makeTempDir("wmp-env-no-ws-");
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

    expect(resolveRootEnvPath({ moduleDir, cwd: root })).toBe(path.join(root, ".env"));
  });

  it("falls back to cwd/.env when neither start dir is inside a monorepo", () => {
    const moduleDir = makeTempDir("wmp-env-mod-none-");
    const cwd = makeTempDir("wmp-env-cwd-none-");

    expect(resolveRootEnvPath({ moduleDir, cwd })).toBe(path.resolve(cwd, ".env"));
  });
});
