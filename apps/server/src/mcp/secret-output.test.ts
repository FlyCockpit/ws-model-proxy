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
 *      at several depths and shapes. Detection is by VALUE, not key name:
 *      every seeded secret (string or bytes, including bytes under innocuous
 *      keys) is searched for in the tool result in every encoding a broken
 *      layer could emit (text, base64, base64url, hex, byte lists, indexed
 *      byte objects), so neither the key redactor nor the serializer's byte
 *      elision can regress alone without failing here.
 *
 * Scope: secrets WMP holds (database credential material and product
 * credentials). The CLI command tools (`forwarder_cli_command_*`) return the
 * text a command printed on the user's own CLI device, behind the separate
 * `allowCliCommands` PAT consent; WMP product credentials in that text are
 * scrubbed by `redactCredentialSubstrings` (packages/config), but arbitrary
 * device content is not WMP secret material and is out of this contract.
 * Their runtime is mocked here so their output goes through the same
 * wrapper chain as every other tool.
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
  // Device-flow polling / user codes and 2FA recovery codes.
  "deviceCode",
  "userCode",
  "backupCodes",
] as const;

/**
 * Secret columns whose names are too generic for the key-name redactor
 * (redacting every `value` key would blank ordinary tool output). They are
 * protected by projection alone: no MCP tool projection or procedure output
 * includes these rows. Listed so the schema check still forces a decision.
 */
const GENERIC_NAME_SECRET_COLUMNS: Readonly<Record<string, string>> = {
  value:
    "Verification.value (email, reset and OAuth code material). Read only inside mcpGrants.revokeMine, which returns a status, never the rows.",
};

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
  authorizationCodeId: "Foreign key to an OAuth authorization code row, not the code.",
  encodedModelId: "URL-safe encoding of a public model id.",
  failureReasonCode: "Machine-readable failure reason.",
};

const SECRET_LOOKING =
  /secret|password|token|ciphertext|nonce|authtag|privatekey|apikey|digest|hash|key$|^key|code|^value$/i;

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

/**
 * Every secret value seeded into the poison, by label: its bytes and, computed
 * once at seeding, every encoding {@link leakedSecrets} searches for.
 */
const SEEDED = new Map<string, { bytes: Uint8Array; encoded: string[] }>();

/**
 * Encodings of the first {@link PREFIX_BYTES} bytes of every seeded value.
 * Each full encoding starts with the matching prefix encoding (12 bytes is a
 * whole number of base64 groups), so a text with none of these cannot hold
 * any full encoding: a sound one-pass pre-filter before the per-label scan.
 */
const PREFIX_BYTES = 12;
const SEEDED_PREFIXES = new Set<string>();

function seed(label: string, bytes: Uint8Array): void {
  const existing = SEEDED.get(label);
  // Rows are rebuilt per tool with identical values: encode each value once.
  if (existing && Buffer.compare(existing.bytes, bytes) === 0) return;
  SEEDED.set(label, { bytes, encoded: encodings(bytes) });
  for (const encoded of encodings(bytes.subarray(0, PREFIX_BYTES), { prefix: true }))
    SEEDED_PREFIXES.add(encoded);
}

function seedText(label: string, value: string): string {
  seed(label, new TextEncoder().encode(value));
  return value;
}

function seedBytes(label: string, value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  seed(label, bytes);
  return bytes;
}

/** One row carrying every secret column with a distinct sentinel value. */
function secretRow(tag: string): Record<string, unknown> {
  const row: Record<string, unknown> = { id: `${tag}-id`, label: `${tag}-label` };
  for (const column of SECRET_COLUMNS) {
    row[column] = seedText(`${tag}.${column}`, `${SENTINEL}-${tag}-${column}`);
  }
  // Byte-typed encrypted material, as Prisma returns it.
  row.ciphertext = seedBytes(`${tag}.ciphertext`, `${SENTINEL}-${tag}-ciphertext-bytes`);
  row.nonce = seedBytes(`${tag}.nonce`, `${SENTINEL}-${tag}-nonce-bytes`);
  row.authTag = seedBytes(`${tag}.authTag`, `${SENTINEL}-${tag}-authtag-bytes`);
  // Byte secrets under INNOCUOUS keys the key redactor does not match: only
  // the serializer's byte elision stands between these and the output.
  row.payload = seedBytes(`${tag}.payload`, `${SENTINEL}-${tag}-payload-bytes`);
  row.data = Buffer.from(seedBytes(`${tag}.data`, `${SENTINEL}-${tag}-buffer-bytes`));
  const backing = new TextEncoder().encode(`xx${SENTINEL}-${tag}-view-bytesxx`);
  row.blob = backing.subarray(2, backing.byteLength - 2);
  seed(`${tag}.blob`, new Uint8Array(row.blob as Uint8Array));
  row.chunks = [seedBytes(`${tag}.chunks`, `${SENTINEL}-${tag}-chunk-bytes`)];
  row.material = seedBytes(
    `${tag}.material`,
    `${PRODUCT_CREDENTIAL_PREFIXES.cliToken}${SENTINEL}-${tag}-credential-bytes`,
  );
  // Plaintext provider API key spellings a future select might leak.
  row.apiKey = seedText(`${tag}.apiKey`, `${SENTINEL}-${tag}-apiKey`);
  row.api_key = seedText(`${tag}.api_key`, `${SENTINEL}-${tag}-api_key`);
  row.providerApiKey = seedText(`${tag}.providerApiKey`, `${SENTINEL}-${tag}-providerApiKey`);
  row.tokenHash = seedText(`${tag}.tokenHash`, `${SENTINEL}-${tag}-tokenHash`);
  row.authorization = seedText(`${tag}.authorization`, `Bearer ${SENTINEL}-${tag}-authorization`);
  // Raw product credentials under innocuous keys, including nested ones.
  row.note = seedText(
    `${tag}.note`,
    `${PRODUCT_CREDENTIAL_PREFIXES.modelApiToken}${SENTINEL}-${tag}-raw`,
  );
  row.description = seedText(
    `${tag}.description`,
    `${PRODUCT_CREDENTIAL_PREFIXES.mcpToken}${SENTINEL}-${tag}-description`,
  );
  row.labels = [
    seedText(
      `${tag}.labels`,
      `${PRODUCT_CREDENTIAL_PREFIXES.deviceCredential}${SENTINEL}-${tag}-l`,
    ),
  ];
  row.meta = {
    hint: seedText(
      `${tag}.meta.hint`,
      `${PRODUCT_CREDENTIAL_PREFIXES.cliToken}${SENTINEL}-${tag}-h`,
    ),
  };
  return row;
}

/**
 * Every representation of a seeded secret a broken layer could emit: the
 * text itself, base64 / base64url / hex, a JSON byte list (`Buffer#toJSON`
 * or an array copy), and the indexed object `JSON.stringify` makes of a
 * Uint8Array that reached a generic object arm.
 */
function encodings(bytes: Uint8Array, { prefix = false } = {}): string[] {
  const buffer = Buffer.from(bytes);
  const list = Array.from(bytes).join(",");
  return [
    new TextDecoder().decode(bytes),
    buffer.toString("base64").replace(/=+$/u, ""),
    buffer.toString("base64url"),
    buffer.toString("hex"),
    // A prefix of a byte list has no closing bracket.
    prefix ? `[${list}` : `[${list}]`,
    Array.from(bytes, (byte, index) => `"${index}":${byte}`).join(","),
  ];
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

/** Labels of the seeded secrets present in `value` in any encoding. */
function leakedSecrets(value: unknown): string[] {
  const text = JSON.stringify(value) ?? "";
  const suspicious =
    text.includes(SENTINEL) || [...SEEDED_PREFIXES].some((encoded) => text.includes(encoded));
  if (!suspicious) return [];
  const leaked = [...SEEDED].flatMap(([label, { encoded }]) =>
    encoded.some((form) => text.includes(form)) ? [label] : [],
  );
  // Catch-all for a sentinel that reached the output in a form not listed.
  if (leaked.length === 0) leaked.push("sentinel-or-prefix");
  return leaked;
}

describe("MCP secret-output contract (every tool)", () => {
  it("every secret-looking Prisma column is classified as secret or explicitly safe", () => {
    const fields = schemaFieldNames();
    expect(fields.length).toBeGreaterThan(50);
    const secret = new Set<string>(SECRET_COLUMNS);
    const unclassified = fields.filter(
      (name) =>
        SECRET_LOOKING.test(name) &&
        !secret.has(name) &&
        !(name in NON_SECRET_COLUMNS) &&
        !(name in GENERIC_NAME_SECRET_COLUMNS),
    );
    expect(unclassified).toEqual([]);
    // Every listed secret column still exists (a rename must update the list).
    for (const column of [...SECRET_COLUMNS, ...Object.keys(GENERIC_NAME_SECRET_COLUMNS)])
      expect(fields).toContain(column);
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
        expect(`${tool.name}: ${leakedSecrets(result).join(" | ")}`).toBe(`${tool.name}: `);
        checked += 1;
      }
    }
    expect(checked).toBe(MCP_TOOL_MANIFEST.length * poisonShapes().length);
    // Every tool x shape runs the real wrapper chain; allow for a loaded CI runner.
  }, 60_000);

  it("the poison is detectable: an unredacted copy leaks every seeded secret", () => {
    // Guards against a vacuous pass: plain JSON of the raw poison (bytes
    // become indexed objects or Buffer byte lists) must reveal every seeded
    // value, strings and bytes alike, through leakedSecrets().
    SEEDED.clear();
    const raw = poisonShapes();
    expect(SEEDED.size).toBeGreaterThan(SECRET_COLUMNS.length * 3);
    expect(leakedSecrets(raw).sort()).toEqual([...SEEDED.keys()].sort());
  });

  it("the byte-elision layer is pinned on its own: bytes under innocuous keys", async () => {
    // Bytes under keys the key redactor does not match reach the serializer.
    // If it ever decoded or enumerated them, the contract test above would
    // report the seeded label; prove the detector sees each such encoding.
    const bytes = seedBytes("probe.payload", `${SENTINEL}-probe-bytes`);
    const { toJsonSafe } = await import("./serialization");
    expect(leakedSecrets(toJsonSafe({ payload: bytes }))).toEqual([]);
    expect(leakedSecrets({ payload: Array.from(bytes) })).toContain("probe.payload");
    expect(leakedSecrets({ payload: Buffer.from(bytes).toString("base64") })).toContain(
      "probe.payload",
    );
    expect(leakedSecrets(JSON.parse(JSON.stringify({ payload: bytes })))).toContain(
      "probe.payload",
    );
    SEEDED.delete("probe.payload");
  });
});
