import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * Manifest-wide secret-output contract (issue #67): NO MCP tool output can
 * contain a secret value — provider API keys, encrypted provider credential
 * material, token secrets or token hashes, OAuth/session tokens, passwords,
 * signing keys — whatever the underlying procedure or core returns.
 *
 * Two parts:
 *   1. Schema coverage: every secret-bearing column in the Prisma schema is
 *      listed in SECRET_COLUMNS (and so poisoned below). A new column whose
 *      name looks secret-bearing fails until it is classified here.
 *   2. Every manifest tool, driven through the REAL wrapper chain
 *      (`runManifestTool`: projector -> redactor -> serializer -> cap), with
 *      its procedure or core returning rows that carry every secret column
 *      at several depths and shapes. No sentinel may reach the tool result.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-secret-output-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const poison = vi.hoisted(() => ({ output: undefined as unknown }));

vi.mock("../model-api/diagnostics.js", () => ({
  runPoolMemberTest: vi.fn(async () => poison.output),
  runChatCompletionDiagnostic: vi.fn(async () => poison.output),
}));

vi.mock("./cli-command-tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cli-command-tools.js")>();
  return {
    ...actual,
    adaptCliCommandRunInput: (input: unknown) => input,
    adaptCliSupervisedStartInput: (input: unknown) => input,
    adaptCliCommandResultInput: (input: unknown) => input,
    runForwarderCliCommand: vi.fn(async () => poison.output),
    runForwarderCliSupervisedCommandStart: vi.fn(async () => poison.output),
    runForwarderCliCommandResult: vi.fn(async () => poison.output),
  };
});

const { runManifestTool } = await import("./tools");
const { MCP_TOOL_MANIFEST } = await import("./tool-manifest");
const { createMcpContext } = await import("./context");
const { PRODUCT_CREDENTIAL_PREFIXES } = await import("@ws-model-proxy/db/forwarder-security");

/**
 * Every secret-bearing column name in the Prisma schema. Values under these
 * keys must never reach MCP output.
 */
const SECRET_COLUMNS = [
  // Better Auth: session / OAuth access / refresh / id tokens, passwords,
  // 2FA secrets, OAuth client secrets, JWKS private keys.
  "token",
  "accessToken",
  "refreshToken",
  "idToken",
  "password",
  "secret",
  "clientSecret",
  "privateKey",
  // Product credentials: model API tokens, CLI tokens, device credentials,
  // MCP personal tokens (only the digest is stored).
  "secretDigest",
  // Encrypted provider API keys (AES-GCM material).
  "ciphertext",
  "nonce",
  "authTag",
] as const;

/**
 * Columns whose names match the secret-looking pattern but hold no secret:
 * each with the reason it is safe to return.
 */
const NON_SECRET_COLUMNS: Readonly<Record<string, string>> = {
  tokenEndpointAuthMethod: "OAuth client metadata (auth method name).",
  signingKeyId: "Key identifier, not key material.",
  publicKey: "Public half of a JWKS key pair.",
  inventoryDigest: "Digest of a CLI's published model inventory.",
  payloadHash: "Digest of an accounting payload for idempotency.",
  bindingDigest: "Cache-affinity routing digest of request content structure.",
  prefixDigest: "Cache-affinity routing digest.",
  conversationDigest: "Cache-affinity routing digest.",
  routingKeyDigest: "Response-stickiness routing digest.",
  upstreamResponseIdDigest: "Digest of an upstream response id.",
  runtimeIdentityKey: "Capacity identity key (endpoint/runtime), not a credential.",
  tokenizer: "Tokenizer name.",
  tokenizerVersion: "Tokenizer version.",
  modelApiTokenId: "Foreign key to a token row.",
  modelApiTokenLookupPrefix: "Public lookup prefix of a token (display metadata).",
  lookupPrefix: "Public lookup prefix of a token (display metadata).",
  keyVersion: "Keyring version label for encrypted credentials.",
  key: "Rate-limit bucket key (client identity), not a credential.",
  displaySuffix: "Last characters of a key shown for recognition, by design.",
  credentialType: "Credential kind enum.",
  tokenLimit: "Numeric limit.",
};

const SECRET_LOOKING =
  /secret|password|token|ciphertext|nonce|authtag|privatekey|apikey|digest|hash|key$|^key/i;

function schemaFieldNames(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const schemaDir = join(here, "../../../../packages/db/prisma/schema");
  const names = new Set<string>();
  for (const file of readdirSync(schemaDir).filter((name) => name.endsWith(".prisma"))) {
    let inModel = false;
    for (const line of readFileSync(join(schemaDir, file), "utf8").split("\n")) {
      if (/^model\s+\w+\s*\{/.test(line)) inModel = true;
      else if (/^\}/.test(line)) inModel = false;
      else if (inModel) {
        const match = /^\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+(String|Bytes|Json)\b/.exec(line);
        if (match?.[1]) names.add(match[1]);
      }
    }
  }
  return [...names];
}

const SENTINEL = "SENTINEL-SECRET";

/** One row carrying every secret column with a distinct sentinel value. */
function secretRow(tag: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id: `${tag}-id`, label: `${tag}-label` };
  for (const column of SECRET_COLUMNS) {
    row[column] = `${SENTINEL}-${tag}-${column}`;
  }
  // Byte-typed encrypted material, as Prisma returns it.
  row.ciphertext = new TextEncoder().encode(`${SENTINEL}-${tag}-ciphertext-bytes`);
  row.nonce = new TextEncoder().encode(`${SENTINEL}-${tag}-nonce-bytes`);
  row.authTag = new TextEncoder().encode(`${SENTINEL}-${tag}-authtag-bytes`);
  // Plaintext provider API key spellings a future select might leak.
  row.apiKey = `${SENTINEL}-${tag}-apiKey`;
  row.api_key = `${SENTINEL}-${tag}-api_key`;
  row.providerApiKey = `${SENTINEL}-${tag}-providerApiKey`;
  row.tokenHash = `${SENTINEL}-${tag}-tokenHash`;
  row.authorization = `Bearer ${SENTINEL}-${tag}-authorization`;
  // A raw product credential under an innocuous key.
  row.note = `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${SENTINEL}-${tag}-raw`;
  return row;
}

/** Secret rows at the top level, nested in relations, and inside wrappers. */
function poisonOutput(): unknown {
  const nested = (tag: string) => ({
    ...secretRow(tag),
    CurrentCredential: secretRow(`${tag}-current`),
    Credentials: [secretRow(`${tag}-credentials`)],
    credential: secretRow(`${tag}-credential`),
    User: { ...secretRow(`${tag}-user`), Accounts: [secretRow(`${tag}-account`)] },
  });
  const rows = [nested("row0"), nested("row1")];
  return Object.assign(rows, {});
}

function poisonShapes(): unknown[] {
  return [
    poisonOutput(),
    { items: poisonOutput(), nextCursor: null, ...secretRow("envelope") },
    secretRow("single"),
  ];
}

const USER: import("./context").McpSessionUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  slug: "test-user-slug",
  role: "user",
  locale: "en-US",
  banned: null,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: true,
  operationalAlerts: true,
};

type ToolClient = Parameters<NonNullable<(typeof MCP_TOOL_MANIFEST)[number]["invokeProcedure"]>>[0];

/** A client whose every procedure leaf resolves to the current poison output. */
function poisonClient(): ToolClient {
  const callable = (): unknown =>
    new Proxy(async () => poison.output, {
      get(_target, prop) {
        return typeof prop === "string" ? callable() : undefined;
      },
    });
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return typeof prop === "string" ? callable() : undefined;
    },
  }) as unknown as ToolClient;
}

/** Arguments that pass every tool's advertised input schema and gates. */
function argsFor(tool: (typeof MCP_TOOL_MANIFEST)[number]): Record<string, unknown> {
  return {
    ...(tool.confirmation !== null ? { confirm: tool.confirmation } : {}),
    memberId: "member-1",
    model: "user/pool",
    messages: [],
    cliDeviceId: "device-1",
    command: "true",
    commandId: "command-1",
    poolId: "pool-1",
  };
}

function containsSentinel(value: unknown): string[] {
  const text = JSON.stringify(value);
  const found: string[] = [];
  let index = text.indexOf(SENTINEL);
  while (index !== -1) {
    found.push(text.slice(Math.max(0, index - 40), index + 60));
    index = text.indexOf(SENTINEL, index + 1);
  }
  return found;
}

describe("MCP secret-output contract (every tool)", () => {
  it("every secret-looking Prisma column is classified as secret or explicitly safe", () => {
    const fields = schemaFieldNames();
    expect(fields.length).toBeGreaterThan(50);
    const secret = new Set<string>(SECRET_COLUMNS);
    const unclassified = fields.filter(
      (name) => SECRET_LOOKING.test(name) && !secret.has(name) && !(name in NON_SECRET_COLUMNS),
    );
    expect(unclassified).toEqual([]);
    // Every listed secret column still exists (a rename must update the list).
    for (const column of SECRET_COLUMNS) expect(fields).toContain(column);
  });

  it("no tool result carries a secret value, whatever its procedure or core returns", async () => {
    const client = poisonClient();
    const orpcContext = createMcpContext({
      user: USER,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2025-06-01T00:00:00Z"),
      services: undefined,
    });
    let checked = 0;
    for (const tool of MCP_TOOL_MANIFEST) {
      for (const shape of poisonShapes()) {
        poison.output = shape;
        const result = await runManifestTool(tool, {
          dispatch: {
            orpcContext,
            requestId: "req-secret",
            credential: {
              kind: "pat",
              tokenId: "pat-1",
              allowCliCommands: true,
              expiresAt: null,
            },
          },
          scopes: ["mcp:read", "mcp:write"],
          client,
          args: argsFor(tool),
        });
        // The poison must have reached the output stage, or the check is vacuous.
        expect(`${tool.name}: ${result.isError === true}`).toBe(`${tool.name}: false`);
        expect(`${tool.name}: ${containsSentinel(result).join(" | ")}`).toBe(`${tool.name}: `);
        checked += 1;
      }
    }
    expect(checked).toBe(MCP_TOOL_MANIFEST.length * poisonShapes().length);
  });

  it("the poison is detectable: an unredacted copy would contain every sentinel", () => {
    // Guards against a vacuous pass (e.g. a sentinel spelled differently).
    const raw = containsSentinel(poisonOutput());
    // The byte-typed columns hold Uint8Array values (not searchable as text).
    const byteColumns = new Set(["ciphertext", "nonce", "authTag"]);
    for (const column of SECRET_COLUMNS.filter((name) => !byteColumns.has(name))) {
      expect(raw.some((snippet) => snippet.includes(`-${column}`))).toBe(true);
    }
  });
});
