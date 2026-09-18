import { readFileSync } from "node:fs";
import { getAuthTables } from "better-auth";
import { describe, expect, it, vi } from "vitest";

/**
 * Automated startup schema validation (MCP plan Phase 9; gap-analysis
 * Section 1 "Better Auth startup schema validation — manual evidence only").
 *
 * The deploy-time guarantee the 1.7.3 prisma-adapter schema check gives us
 * is: for the ENABLED plugin set, every table and field the runtime expects
 * exists in the database. This test automates the schema-file half of that
 * check WITHOUT a live database: it boots the REAL production auth instance
 * from ./index.ts (the exact option set — admin, twoFactor,
 * deviceAuthorization, and the FULL flag-on MCP plugin list via
 * resolveMcpPlugins — the deploy-time superset), derives the expected
 * tables/fields through better-auth's own `getAuthTables` (the same source
 * the CLI generator and the runtime schema diff consume), and asserts every
 * expected model and field exists in the committed Prisma schema.
 *
 * The live-adapter half (the runtime check against a real disposable
 * PostgreSQL, including column-type/nullability reconciliation) remains the
 * labeled disposable-PostgreSQL suite (Part K2) deferral.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    NODE_ENV: "test",
    // Flag ON: the deploy-time superset — the schema must satisfy the FULL
    // MCP surface (jwt/mcp/cimd tables), never only the dormant subset.
    WMP_MCP_ENABLED: true,
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "startup-schema-test-secret-at-least-32-chars",
    CORS_ORIGIN: undefined,
    SMTP_HOST: undefined,
  },
}));

// Prisma seam: a permissive callable-proxy stub. The 1.7.3 prisma adapter
// validates client SHAPE asynchronously at construction (the deferred
// startup check — a bare {} makes it reject with "Model ... does not
// exist"); the stub answers every delegate/method probe with a settled
// promise so construction completes. This test never triggers real adapter
// OPERATIONS, and the LIVE check against actual PostgreSQL stays the
// Part K2 deferral.
const makePrismaStub = (): unknown =>
  new Proxy(() => Promise.resolve(undefined), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop, receiver);
      return makePrismaStub();
    },
  });
vi.mock("@ws-model-proxy/db", () => ({ default: makePrismaStub() }));

vi.mock("@ws-model-proxy/mailer", () => ({
  isEmailConfigured: () => false,
  sendEmail: vi.fn(),
  renderVerifyEmail: vi.fn(() => ({ subject: "", html: "" })),
  renderTwoFactorOtp: vi.fn(() => ({ subject: "", html: "" })),
  verifyTransport: vi.fn(async () => false),
}));

// The REAL production instance (module-scope construction over the mocked
// Prisma seam — no connection is made; the 1.7.3 adapter schema check is
// deferred to first use, which these tests never trigger).
const { auth } = await import("./index");

const schema = readFileSync(new URL("../../db/prisma/schema/auth.prisma", import.meta.url), "utf8");

const modelBlock = (name: string): string => {
  const match = schema.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m"));
  return match?.[0] ?? "";
};

const modelFieldNames = (name: string): Set<string> =>
  new Set([...modelBlock(name).matchAll(/^\s{2}(\w+)\s+\S+/gm)].map((match) => match[1]!));

/** Adapter table key / modelName → Prisma model name (first letter upper). */
const prismaModelFor = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

interface AuthTable {
  modelName?: string;
  fields?: Record<string, unknown>;
}
const tables = getAuthTables(auth.options) as Record<string, AuthTable>;

describe("startup schema validation — real auth options vs the committed Prisma schema", () => {
  it("the real instance resolves the deploy-time plugin set (flag ON: OAuth/JWKS/2FA/device tables present)", () => {
    const keys = Object.keys(tables);
    for (const required of [
      "user",
      "session",
      "account",
      "verification",
      "twoFactor",
      "jwks",
      "oauthClient",
      "oauthRefreshToken",
      "oauthConsent",
      "deviceCode",
    ]) {
      expect(keys, `getAuthTables must declare ${required}`).toContain(required);
    }
  });

  it("every table the enabled plugins expect exists as a Prisma model under the adapter's name mapping", () => {
    for (const [key, table] of Object.entries(tables)) {
      const model = prismaModelFor(table.modelName ?? key);
      expect(modelBlock(model), `table ${key} → model ${model}`).not.toBe("");
    }
  });

  it("every field the enabled plugins declare exists on the mapped Prisma model", () => {
    for (const [key, table] of Object.entries(tables)) {
      const model = prismaModelFor(table.modelName ?? key);
      const declared = modelFieldNames(model);
      for (const field of Object.keys(table.fields ?? {})) {
        expect(declared, `${model}.${field} (table ${key})`).toContain(field);
      }
    }
  });

  it("user additionalFields (locale/operationalAlerts/slug) are expected and declared", () => {
    const userFields = new Set(Object.keys(tables.user?.fields ?? {}));
    for (const additional of ["locale", "operationalAlerts", "slug"]) {
      expect(userFields, `user.${additional} must be part of the runtime table`).toContain(
        additional,
      );
      expect(modelFieldNames("User")).toContain(additional);
    }
  });
});
