import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The production bundle (tsdown) inlines `@ws-model-proxy/*` and every package the server does
 * not declare. A Better Auth package that `packages/auth` imports while an external Better Auth
 * package (`@better-auth/mcp`) imports it too would then exist twice: request state set by one
 * copy (`getOAuthProviderState`) is invisible to the other, and the OAuth authorize and consent
 * endpoints fail in the built server only. So every `@better-auth/*` package `packages/auth`
 * imports at runtime must be a server dependency (kept external, one instance).
 */
const root = resolve(import.meta.dirname, "../../..");
const authSrc = join(root, "packages/auth/src");

function runtimeBetterAuthImports(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(authSrc)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const text = readFileSync(join(authSrc, file), "utf8");
    for (const match of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(@better-auth\/[^/"]+)/gm))
      if (match[1]) found.add(match[1]);
  }
  return found;
}

describe("Better Auth packages in the server bundle", () => {
  it("declares every @better-auth package packages/auth imports, so none is bundled twice", () => {
    const server = JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const imported = runtimeBetterAuthImports();
    expect(imported).toContain("@better-auth/oauth-provider");
    for (const name of imported) expect(server.dependencies ?? {}, name).toHaveProperty([name]);
  });
});
