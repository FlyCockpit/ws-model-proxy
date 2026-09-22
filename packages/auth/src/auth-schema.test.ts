import { readFileSync } from "node:fs";
import { mcp } from "@better-auth/mcp";
import { jwt, twoFactor } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

/**
 * Structural schema-shape assertions for the Better Auth 1.7.3 reconciliation
 * (Phase 0b). packages/db has no vitest setup, so this reads the
 * Prisma schema file directly; `pnpm db:validate` + `pnpm db:generate` cover
 * syntax/client generation, and the runtime prisma-adapter schema check
 * (registered by better-auth 1.7.3 and awaited before HTTP dispatch) covers
 * table/column presence against the enabled plugin set at startup.
 *
 * The expected field inventory is derived programmatically from the INSTALLED
 * plugin schema objects (`twoFactor().schema`, `jwt().schema`,
 * `mcp().schema` — the same source the Better Auth CLI generator consumes),
 * so a MISSING field or a base-type mismatch on the reconciled plugin tables
 * fails here instead of at first startup; the exact coverage boundaries are
 * the qualified claim below.
 *
 * Coverage claim (exact): declared-field presence/base-type coverage for the
 * reconciled plugin tables, plus explicitly pinned constraints
 * (unique/index/relation shapes), nullability-exact pins, and pinned
 * timestamp/deviation sets; nullability outside pinned fields, FK referential
 * actions, and tables without plugin-derived inventories are not covered.
 */
const schema = readFileSync(new URL("../../db/prisma/schema/auth.prisma", import.meta.url), "utf8");

/** Every model declared in auth.prisma, derived from the file itself. */
const modelNames = [...schema.matchAll(/^model (\w+) \{/gm)].map((match) => match[1]!);

// Exact-set comparison helper: order-insensitive (Prisma field order is
// not load-bearing; field MEMBERSHIP is).
const expectSameSet = (actual: string[], expected: string[], label: string): void => {
  expect([...actual].sort(), label).toEqual([...expected].sort());
};

function modelBlock(name: string): string {
  const match = schema.match(new RegExp(`^model ${name} \\{[\\s\\S]*?^\\}`, "m"));
  expect(match, `model ${name} must exist in auth.prisma`).toBeDefined();
  return match![0]!;
}

const twoFactorSchema = twoFactor().schema as unknown as Record<
  string,
  { fields?: Record<string, { type: string }> }
>;
const jwtSchema = jwt().schema as unknown as Record<
  string,
  { fields?: Record<string, { type: string }> }
>;
const mcpSchema = mcp({
  resource: "https://ws-model-proxy.localhost/mcp",
  loginPage: "/mcp-login",
  consentPage: "/mcp-consent",
}).schema as unknown as Record<string, { fields?: Record<string, { type: string }> }>;

const oauthModels = [
  "OauthClient",
  "OauthResource",
  "OauthClientResource",
  "OauthRefreshToken",
  "OauthAccessToken",
  "OauthConsent",
  "OauthClientAssertion",
  "Jwks",
] as const;

describe("TwoFactor 1.7.3 reconciliation", () => {
  const twoFactor = modelBlock("TwoFactor");

  it("keeps the one-row-per-user unique constraint on userId", () => {
    // Better Auth 1.7.3 only declares an index on userId; this repo's unique
    // constraint is the intentional strengthening that makes the
    // one-row-per-user runtime contract (all 2FA reads/writes key by userId)
    // enforced by the database.
    expect(twoFactor).toContain("@@unique([userId])");
  });

  it("adds the lockout columns with generated nullability/defaults", () => {
    expect(twoFactor).toMatch(/failedVerificationCount\s+Int\?\s+@default\(0\)/);
    expect(twoFactor).toMatch(/lockedUntil\s+DateTime\?/);
  });

  it("adds the generated secret lookup index", () => {
    expect(twoFactor).toContain("@@index([secret])");
  });
});

describe("OAuth/JWKS model set (dormant until WMP_MCP_ENABLED)", () => {
  it.each(oauthModels)("declares %s with its adapter model key", (name) => {
    const block = modelBlock(name);
    // Adapter model keys must not be renamed: better-auth's prisma adapter
    // addresses e.g. prisma.oauthClient, derived from these @@map-free model
    // names, and the runtime schema check compares them directly.
    expect(block).toContain("@@map(");
  });

  it("maps models to snake_case table names per repo convention", () => {
    const expected: Record<string, string> = {
      OauthClient: "oauth_client",
      OauthResource: "oauth_resource",
      OauthClientResource: "oauth_client_resource",
      OauthRefreshToken: "oauth_refresh_token",
      OauthAccessToken: "oauth_access_token",
      OauthConsent: "oauth_consent",
      OauthClientAssertion: "oauth_client_assertion",
      Jwks: "jwks",
    };
    for (const [model, table] of Object.entries(expected)) {
      expect(modelBlock(model)).toContain(`@@map("${table}")`);
    }
  });

  it("preserves unique token hashes and the client/resource compound uniqueness", () => {
    // Nullability-exact pins: making a pinned non-nullable field nullable fails.
    expect(modelBlock("OauthRefreshToken")).toMatch(/token\s+String(?![?[\w])\s+@unique/);
    expect(modelBlock("OauthAccessToken")).toMatch(/token\s+String(?![?[\w])\s+@unique/);
    expect(modelBlock("OauthClientResource")).toContain("@@unique([clientId, resourceId])");
  });

  it("preserves rotation/replay, DPoP confirmation, and authorization-code lookup columns", () => {
    const refresh = modelBlock("OauthRefreshToken");
    expect(refresh).toMatch(/rotatedAt\s+DateTime\?/);
    expect(refresh).toMatch(/rotationReplayResponse\s+String\?/);
    expect(refresh).toMatch(/rotationReplayExpiresAt\s+DateTime\?/);
    expect(refresh).toMatch(/confirmation\s+Json\?/);
    expect(refresh).toMatch(/authorizationCodeId\s+String\?/);
    expect(modelBlock("OauthAccessToken")).toMatch(/confirmation\s+Json\?/);
  });

  it("preserves session set-null and user/refresh cascade relations", () => {
    expect(modelBlock("OauthRefreshToken")).toContain("onDelete: SetNull");
    expect(modelBlock("OauthAccessToken")).toContain("onDelete: SetNull");
    expect(modelBlock("OauthAccessToken")).toMatch(
      /refresh\s+OauthRefreshToken\?\s+@relation\(fields: \[refreshId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("declares the required User/Session back-relations", () => {
    const user = modelBlock("User");
    expect(user).toMatch(/oauthClients\s+OauthClient\[\]/);
    expect(user).toMatch(/oauthRefreshTokens\s+OauthRefreshToken\[\]/);
    expect(user).toMatch(/oauthAccessTokens\s+OauthAccessToken\[\]/);
    expect(user).toMatch(/oauthConsents\s+OauthConsent\[\]/);
    expect(user).toMatch(/mcpGrants\s+McpGrant\[\]/);
    expect(user).toMatch(/mcpPersonalTokens\s+McpPersonalToken\[\]/);
    const session = modelBlock("Session");
    expect(session).toMatch(/oauthRefreshTokens\s+OauthRefreshToken\[\]/);
    expect(session).toMatch(/oauthAccessTokens\s+OauthAccessToken\[\]/);
  });
});

describe("McpGrant (application-owned)", () => {
  const grant = modelBlock("McpGrant");

  it("enforces unique (userId, clientId, referenceId) generations", () => {
    expect(grant).toContain("@@unique([userId, clientId, referenceId])");
  });

  it("indexes owner/client lookup and cascades only on user deletion", () => {
    expect(grant).toContain("@@index([userId, clientId])");
    expect(grant).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("keeps clientId a plain verified OAuth client identifier (no client relation)", () => {
    expect(grant).toMatch(/clientId\s+String/);
    expect(grant).not.toContain("OauthClient");
  });

  it("has an opaque id and a nullable revokedAt tombstone column", () => {
    expect(grant).toMatch(/id\s+String\s+@id\s+@default\(cuid\(2\)\)/);
    expect(grant).toMatch(/revokedAt\s+DateTime\?/);
    expect(grant).toMatch(/referenceId\s+String/);
  });
});

describe("McpPersonalToken (application-owned)", () => {
  const token = modelBlock("McpPersonalToken");

  it("enforces unique lookup prefix and secret digest", () => {
    expect(token).toContain("@@unique([lookupPrefix])");
    expect(token).toContain("@@unique([secretDigest])");
  });

  it("keeps the one-token-per-grant relation unique and cascading", () => {
    // Field-level @unique on grantId (not a block-level @@unique) is the
    // 1:1 pin: one token owns exactly one grant generation.
    expect(token).toMatch(/grantId\s+String\s+@unique/);
    expect(token).toMatch(
      /grant\s+McpGrant\s+@relation\(fields: \[grantId\], references: \[id\], onDelete: Cascade\)/,
    );
  });

  it("indexes owner/revocation lookup and expiry sweeps, cascading on user deletion", () => {
    expect(token).toContain("@@index([userId, revokedAt])");
    expect(token).toContain("@@index([expiresAt])");
    expect(token).toMatch(
      /user\s+User\s+@relation\("McpPersonalTokenOwner", fields: \[userId\], references: \[id\], onDelete: Cascade\)/,
    );
  });
});

describe("field inventory derived from the installed 1.7.3 plugin schemas", () => {
  // Plugin schema table key -> Prisma model. The prisma models carry extra
  // columns (id, relation scalars like sessionId/refreshId are plugin fields,
  // relation objects are Prisma-only); the direction under test is: every
  // field the installed plugins declare must exist with the mapped type.
  const tableToModel: Record<string, string> = {
    twoFactor: "TwoFactor",
    jwks: "Jwks",
    oauthClient: "OauthClient",
    oauthResource: "OauthResource",
    oauthClientResource: "OauthClientResource",
    oauthRefreshToken: "OauthRefreshToken",
    oauthAccessToken: "OauthAccessToken",
    oauthConsent: "OauthConsent",
    oauthClientAssertion: "OauthClientAssertion",
  };

  // The documented, deliberate type deviations from generator output.
  const typeDeviations: Record<string, string> = {
    // oauth-provider@1.7.3 runtime seeds null into allowedScopes in three
    // code paths (see the model comment in auth.prisma); Prisma cannot
    // express a nullable native list, so this is Json? by design.
    "OauthResource.allowedScopes": "Json?",
  };

  const prismaTypeFor = (model: string, field: string, pluginType: string): string => {
    const deviation = typeDeviations[`${model}.${field}`];
    if (deviation) return deviation;
    switch (pluginType) {
      case "string":
        return "String";
      case "number":
        return "Int";
      case "boolean":
        return "Boolean";
      case "date":
        return "DateTime";
      case "string[]":
        return "String[]";
      case "json":
        return "Json";
      default:
        throw new Error(`unknown plugin field type ${pluginType} for ${model}.${field}`);
    }
  };

  const sources: Array<[string, Record<string, { fields?: Record<string, { type: string }> }>]> = [
    ["twoFactor()", twoFactorSchema],
    ["jwt()", jwtSchema],
    ["mcp()", mcpSchema],
  ];

  for (const [sourceName, pluginSchema] of sources) {
    for (const [table, model] of Object.entries(tableToModel)) {
      const fields = pluginSchema[table]?.fields;
      if (!fields) continue; // table belongs to another plugin's schema
      it.each(Object.entries(fields))(
        `${sourceName} ${table}.%s maps to ${model}.%s with the expected Prisma type`,
        (field, attributes) => {
          const expectedType = prismaTypeFor(model, field, attributes.type);
          const escapedType = expectedType.replace(/[?[\]]/g, (ch) => `\\${ch}`);
          if (typeDeviations[`${model}.${field}`]) {
            // Documented deviations are pinned nullability-EXACTLY: the
            // declared type (including its `?`) must match verbatim.
            expect(modelBlock(model)).toMatch(
              new RegExp(`^\\s*${field}\\s+${escapedType}(?=[\\s@]|$)`, "m"),
            );
            return;
          }
          // Nullability is tolerant here (optional plugin fields may map to
          // `?` columns); exact nullability is pinned for load-bearing fields
          // and for the timestamp/deviation sets below.
          expect(modelBlock(model)).toMatch(
            new RegExp(`^\\s*${field}\\s+${escapedType}\\??(?=[\\s@]|$)`, "m"),
          );
        },
      );
    }
  }

  it("covers every reconciled table from the installed plugin schemas", () => {
    const covered = new Set<string>();
    for (const [, pluginSchema] of sources) {
      for (const table of Object.keys(tableToModel)) {
        if (pluginSchema[table]?.fields) covered.add(table);
      }
    }
    expect([...covered].sort()).toEqual([...Object.keys(tableToModel)].sort());
  });

  it("keeps the twoFactor plugin's user.twoFactorEnabled column", () => {
    expect(modelBlock("User")).toMatch(/twoFactorEnabled\s+Boolean\?/);
  });
});

describe("intentional generator deviations are pinned", () => {
  // Any NEW deviation from the generator-equivalent output must fail these
  // exact-set assertions, forcing an explicit decision + doc update.

  const fieldsWith = (model: string, attribute: string): string[] => {
    const block = modelBlock(model);
    // `id` fields are NOT excluded: they are part of the inventory, so an
    // `id DateTime @default(now())` (e.g. on a model whose PK is another
    // column, like AppSetting's `key`) is caught by the pinned sets. The
    // standard `id String @id @default(cuid(2))` entries match neither
    // @default(now()) nor @updatedAt, so the pinned sets simply cover them.
    return [...block.matchAll(new RegExp(`^\\s*(\\w+)\\s+\\S+.*${attribute}`, "gm"))].map(
      (match) => match[1]!,
    );
  };

  // Baseline (non-plugin) models' current timestamp conventions are pinned
  // too — that is intended: any timestamp change anywhere in auth.prisma
  // must be an explicit, reviewed decision. AppSetting/DeviceCode follow the
  // repo-wide createdAt+updatedAt(@updatedAt) convention; OauthClientAssertion
  // alone carries no timestamps (expiresAt is a plain required column).
  const defaultNowSets: Record<string, string[]> = {
    User: ["createdAt", "updatedAt"],
    Session: ["createdAt", "updatedAt"],
    Account: ["createdAt", "updatedAt"],
    Verification: ["createdAt", "updatedAt"],
    TwoFactor: ["createdAt", "updatedAt"],
    OauthClient: ["createdAt", "updatedAt"],
    OauthResource: ["createdAt", "updatedAt"],
    OauthClientResource: ["createdAt"],
    OauthRefreshToken: ["createdAt"],
    OauthAccessToken: ["createdAt"],
    OauthConsent: ["createdAt", "updatedAt"],
    OauthClientAssertion: [],
    Jwks: ["createdAt"],
    McpGrant: ["createdAt", "updatedAt"],
    McpPersonalToken: ["createdAt", "updatedAt"],
    AppSetting: ["createdAt", "updatedAt"],
    DeviceCode: ["createdAt", "updatedAt"],
  };

  const updatedAtSets: Record<string, string[]> = {
    User: ["updatedAt"],
    Session: ["updatedAt"],
    Account: ["updatedAt"],
    Verification: ["updatedAt"],
    TwoFactor: ["updatedAt"],
    OauthClient: ["updatedAt"],
    OauthResource: ["updatedAt"],
    OauthClientResource: [],
    OauthRefreshToken: [],
    OauthAccessToken: [],
    OauthConsent: ["updatedAt"],
    OauthClientAssertion: [],
    Jwks: [],
    McpGrant: ["updatedAt"],
    McpPersonalToken: ["updatedAt"],
    AppSetting: ["updatedAt"],
    DeviceCode: ["updatedAt"],
  };

  it("pins the exact @default(now()) set for EVERY model in auth.prisma", () => {
    // The inventory is derived from the file itself, so adding a model (or a
    // timestamp on any existing model) without updating the pinned sets
    // fails here.
    expectSameSet(modelNames, Object.keys(defaultNowSets), "model inventory");
    for (const model of modelNames) {
      expectSameSet(
        fieldsWith(model, "@default\\(now\\(\\)\\)"),
        defaultNowSets[model] ?? [],
        `${model} @default(now()) set`,
      );
    }
  });

  it("pins the exact @updatedAt set for EVERY model in auth.prisma", () => {
    expectSameSet(modelNames, Object.keys(updatedAtSets), "model inventory");
    for (const model of modelNames) {
      expectSameSet(
        fieldsWith(model, "@updatedAt"),
        updatedAtSets[model] ?? [],
        `${model} @updatedAt set`,
      );
    }
  });

  it("pins the allowedScopes Json? deviation (null-seeding runtime writers)", () => {
    // Upstream v1.7.3's own generator emits `allowedScopes String[]`, but the
    // runtime seeds null on fresh databases (generator/runtime inconsistency);
    // Json? is the documented fix. See the OauthResource comment in auth.prisma.
    expect(modelBlock("OauthResource")).toMatch(/allowedScopes\s+Json\?/);
  });

  it("keeps load-bearing field shapes the flagged reviewers called out", () => {
    // Negative lookaheads make these pins nullability-EXACT: making a pinned
    // non-nullable field nullable (String?, String[]?, DateTime?) fails.
    const jwks = modelBlock("Jwks");
    expect(jwks).toMatch(/publicKey\s+String(?![?[\w])/);
    expect(jwks).toMatch(/privateKey\s+String(?![?[\w])/);
    expect(jwks).toMatch(/createdAt\s+DateTime(?![?[\w])\s+@default\(now\(\)\)/);
    expect(modelBlock("OauthResource")).toMatch(/identifier\s+String(?![?[\w])\s+@unique/);
    const client = modelBlock("OauthClient");
    expect(client).toMatch(/clientId\s+String(?![?[\w])\s+@unique/);
    expect(client).toMatch(/redirectUris\s+String\[\](?![?\w])/);
    expect(client).toMatch(/scopes\s+String\[\](?![?\w])/);
  });
});
