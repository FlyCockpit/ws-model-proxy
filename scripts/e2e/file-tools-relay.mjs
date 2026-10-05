import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";
import { openTerminalTestClient } from "./terminal-client.mjs";

// End-to-end check of MCP node file tools (current relay, #103/#106): a real server,
// a real wsmp relay CLI, a Postgres database and an MCP personal access token.
//
//   WSMP_E2E_DATABASE_URL=postgres://… node scripts/e2e/file-tools-relay.mjs
//
// It needs a built server (apps/server/dist/index.mjs) and a built CLI
// (apps/cli/target/debug/wsmp); override with WSMP_E2E_SERVER_ENTRY and
// WSMP_E2E_CLI_BINARY. Optional: WSMP_E2E_OLD_CLI_BINARY, a wsmp that speaks
// relay 2.3, to check the upgrade message with the real binary as well (a
// scripted 2.3 hello is always checked).

// `pg` and `ws` are existing dependencies of @ws-model-proxy/db and the server.
const requireFromDb = createRequire(new URL("../../packages/db/package.json", import.meta.url));
const requireFromServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const pg = requireFromDb("pg");
const WebSocket = requireFromServer("ws");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("WSMP_E2E_DATABASE_URL");
const cliSlug = process.env.WSMP_E2E_CLI_SLUG?.trim() || "file-tools-e2e";
const root = resolve(import.meta.dirname, "../..");
const versionSource = await readFile(
  join(root, "packages/api/src/lib/relay-protocol-version.ts"),
  "utf8",
);
const currentProtocol = /RELAY_PROTOCOL_VERSIONS\s*=\s*\["([^"]+)"\]/.exec(versionSource)?.[1];
assert(currentProtocol, "canonical relay protocol declaration missing");
const scratch = await mkdtemp(join(tmpdir(), "wsmp-file-tools-e2e-"));
const userId = randomUUID();
let db;
let server;
let relay;

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

try {
  const cliBinary = resolve(process.env.WSMP_E2E_CLI_BINARY || "apps/cli/target/debug/wsmp");
  const serverEntry = resolve(process.env.WSMP_E2E_SERVER_ENTRY || "apps/server/dist/index.mjs");
  await access(cliBinary);
  await access(serverEntry);
  const betterAuthSecret = randomBytes(48).toString("base64url");
  const credential = (prefix, purpose) => {
    const secret = `${prefix}${randomBytes(32).toString("base64url")}`;
    const key = createHmac("sha256", betterAuthSecret)
      .update(`ws-model-proxy:${purpose}:v1`)
      .digest();
    return {
      secret,
      lookupPrefix: secret.slice(0, prefix.length + 12),
      digest: createHmac("sha256", key).update(secret).digest("base64url"),
    };
  };
  const cliCredential = credential("wsmp_cli_", "cli-token");
  const patCredential = credential("wsmp_mcp_", "mcp-token");

  const portProbe = createServer();
  await new Promise((resolveListen, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, "127.0.0.1", resolveListen);
  });
  const portAddress = portProbe.address();
  assert(portAddress && typeof portAddress === "object");
  const serverPort = portAddress.port;
  await new Promise((resolveClose) => portProbe.close(resolveClose));
  const serverUrl = `http://127.0.0.1:${serverPort}`;

  // Seed: a user, an UNSUPERVISED CLI device with a token bound to it, and a PAT
  // minted with mcp:write and CLI commands (the file tools' credential rule).
  db = new pg.Pool({ connectionString: databaseUrl, max: 1, options: "-c wsmp.fences=,*," });
  const deviceId = randomUUID();
  const cliTokenId = randomUUID();
  const patId = randomUUID();
  const grantId = randomUUID();
  await db.query(
    `INSERT INTO "user" (id, "createdAt", "updatedAt", name, email, slug, "emailVerified", role, locale)
     VALUES ($1, now(), now(), $2, $3, $4, true, 'user', 'en-US')`,
    [userId, "File tools E2E", `file-tools-e2e-${userId}@invalid.test`, `e2e-${userId}`],
  );
  await db.query(
    `INSERT INTO cli_device (id, "createdAt", "updatedAt", "userId", slug, "mcpCommandMode")
     VALUES ($1, now(), now(), $2, $3, 'UNSUPERVISED')`,
    [deviceId, userId, cliSlug],
  );
  await db.query(
    `INSERT INTO cli_token (id, "createdAt", "updatedAt", "userId", "cliDeviceId", name, "lookupPrefix", "secretDigest")
     VALUES ($1, now(), now(), $2, $3, $4, $5, $6)`,
    [
      cliTokenId,
      userId,
      deviceId,
      "File tools E2E",
      cliCredential.lookupPrefix,
      cliCredential.digest,
    ],
  );
  await db.query(
    `INSERT INTO mcp_grant (id, "createdAt", "updatedAt", "userId", "clientId", "referenceId")
     VALUES ($1, now(), now(), $2, $3, 'pat')`,
    [grantId, userId, `pat:${patId}`],
  );
  await db.query(
    `INSERT INTO mcp_personal_token
       (id, "createdAt", "updatedAt", "userId", name, "lookupPrefix", "secretDigest", scopes, "allowCliCommands", "grantId")
     VALUES ($1, now(), now(), $2, $3, $4, $5, ARRAY['mcp:read','mcp:write'], true, $6)`,
    [patId, userId, "File tools E2E", patCredential.lookupPrefix, patCredential.digest, grantId],
  );

  const childBaseEnv = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );

  server = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...childBaseEnv,
      WSMP_DISABLE_DOTENV: "1",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      SERVER_PORT: String(serverPort),
      BETTER_AUTH_SECRET: betterAuthSecret,
      BETTER_AUTH_URL: serverUrl,
      SIGNUP_ENABLED: "false",
      // The supervised scenarios poll `forwarder_cli_command_result`; the default
      // 120 requests a minute per IP would throttle a test that runs on one address.
      RATE_LIMIT_MCP_POINTS: "100000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  for (const stream of [server.stdout, server.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      serverLog += chunk;
    });
  }

  const configPath = join(scratch, "config.json");
  const stateDir = join(scratch, "state");
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      serverUrl,
      cliSlug,
      cliTokenEnv: "WSMP_E2E_CLI_TOKEN",
      endpoints: [],
      mediaTrustedOrigins: [],
      mcpCommandMode: "unsupervised",
    }),
    { mode: 0o600 },
  );
  let relayLog = "";
  const launchRelay = () => {
    const child = spawn(cliBinary, ["connect"], {
      cwd: root,
      detached: process.platform !== "win32",
      env: {
        ...childBaseEnv,
        WSMP_CONFIG: configPath,
        WSMP_STATE_DIR: stateDir,
        WSMP_E2E_CLI_TOKEN: cliCredential.secret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        relayLog += chunk;
      });
    }
    return child;
  };
  relay = launchRelay();

  // ---- MCP over HTTP with the PAT -----------------------------------------
  let requestId = 0;
  const envelope = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "file-tools-e2e", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const mcp = async (method, params, headers = {}) => {
    requestId += 1;
    const response = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${patCredential.secret}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-method": method,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params: { ...params, _meta: envelope },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, `mcp ${method} -> ${response.status}: ${text}`);
    return JSON.parse(text);
  };
  /** Calls a tool and returns `{ isError, result, error, text }` from the in-band result. */
  const tool = async (name, args) => {
    const reply = await mcp("tools/call", { name, arguments: args }, { "mcp-name": name });
    assert(reply.result, `no result for ${name}: ${JSON.stringify(reply)}`);
    const structured = reply.result.structuredContent ?? {};
    return {
      isError: reply.result.isError === true,
      result: structured.result,
      error: structured.error,
      text: reply.result.content?.[0]?.text ?? "",
    };
  };

  // Wait for the CLI to connect at the canonical protocol and for the file tools to be usable.
  const readyDeadline = Date.now() + 40_000;
  let connected = false;
  while (Date.now() < readyDeadline) {
    if (relay.exitCode !== null) throw new Error(`Rust relay exited early:\n${relayLog}`);
    if (server.exitCode !== null) throw new Error(`WSMP server exited early:\n${serverLog}`);
    const row = await db.query(
      `SELECT status, "relayProtocolVersion" FROM cli_device WHERE id = $1`,
      [deviceId],
    );
    if (
      row.rows[0]?.status === "CONNECTED" &&
      row.rows[0]?.relayProtocolVersion === currentProtocol
    ) {
      connected = true;
      break;
    }
    await sleep(250);
  }
  assert(connected, `CLI did not connect at relay ${currentProtocol}; relay log:\n${relayLog}`);

  // The PAT sees all nine tools.
  const listed = await mcp("tools/list", {});
  const names = new Set(listed.result.tools.map((entry) => entry.name));
  const fileTools = [
    "forwarder_cli_file_read",
    "forwarder_cli_file_stat",
    "forwarder_cli_dir_list",
    "forwarder_cli_file_search",
    "forwarder_cli_file_edit",
    "forwarder_cli_file_write",
    "forwarder_cli_file_rename",
    "forwarder_cli_dir_create",
    "forwarder_cli_file_delete",
  ];
  for (const name of fileTools) assert(names.has(name), `${name} is not listed for the PAT`);

  const device = await tool("forwarder_cli_device_get", { cliDeviceId: deviceId });
  assert.deepEqual(device.result.fileTools, { read: "headless", write: "headless" });

  const work = join(scratch, "work");
  await mkdir(work);
  const notes = join(work, "notes.txt");

  // ---- create -> read -> edit with etag -> stale conflict -------------------
  const created = await tool("forwarder_cli_file_write", {
    cliDeviceId: deviceId,
    path: notes,
    content: "alpha\nbeta\ngamma\n",
    confirm: "RUN",
  });
  assert(!created.isError, `write failed: ${created.text}`);
  assert.equal(created.result.created, true);
  assert.equal(await readFile(notes, "utf8"), "alpha\nbeta\ngamma\n");

  const exists = await tool("forwarder_cli_file_write", {
    cliDeviceId: deviceId,
    path: notes,
    content: "clobber",
    confirm: "RUN",
  });
  assert(exists.isError);
  assert.equal(exists.error.code, "exists");
  assert.equal(
    await readFile(notes, "utf8"),
    "alpha\nbeta\ngamma\n",
    "a refused write changed the file",
  );

  const read = await tool("forwarder_cli_file_read", { cliDeviceId: deviceId, path: notes });
  assert(!read.isError, `read failed: ${read.text}`);
  assert.equal(read.result.text, "1|alpha\n2|beta\n3|gamma");
  assert.equal(read.result.etag, created.result.etag);
  const unchanged = await tool("forwarder_cli_file_read", {
    cliDeviceId: deviceId,
    path: notes,
    ifNoneMatch: read.result.etag,
  });
  assert.deepEqual(unchanged.result, { unchanged: true, etag: read.result.etag });

  const edited = await tool("forwarder_cli_file_edit", {
    cliDeviceId: deviceId,
    path: notes,
    expectedEtag: read.result.etag,
    edits: [{ oldText: "beta", newText: "BETA", expectedMatches: 1 }],
    returnDiff: true,
    reason: "e2e edit",
    confirm: "RUN",
  });
  assert(!edited.isError, `edit failed: ${edited.text}`);
  assert.equal(edited.result.previousEtag, read.result.etag);
  assert.notEqual(edited.result.etag, read.result.etag);
  assert.equal(await readFile(notes, "utf8"), "alpha\nBETA\ngamma\n");

  const stale = await tool("forwarder_cli_file_edit", {
    cliDeviceId: deviceId,
    path: notes,
    expectedEtag: read.result.etag,
    edits: [{ oldText: "gamma", newText: "GAMMA" }],
    confirm: "RUN",
  });
  assert(stale.isError);
  assert.equal(stale.error.code, "conflict");
  assert.equal(stale.error.currentEtag, edited.result.etag);
  assert.equal(
    await readFile(notes, "utf8"),
    "alpha\nBETA\ngamma\n",
    "a stale edit changed the file",
  );

  const stat = await tool("forwarder_cli_file_stat", {
    cliDeviceId: deviceId,
    paths: [notes, join(work, "missing")],
    hash: true,
  });
  assert.equal(stat.result.entries[0].etag, edited.result.etag);
  assert.equal(stat.result.entries[1].error, "not_found");

  // ---- rename, mkdir, list, search, delete -----------------------------------
  const renamedPath = join(work, "renamed.txt");
  const renamed = await tool("forwarder_cli_file_rename", {
    cliDeviceId: deviceId,
    from: notes,
    to: renamedPath,
    confirm: "RUN",
  });
  assert(!renamed.isError, `rename failed: ${renamed.text}`);
  assert.equal(await readFile(renamedPath, "utf8"), "alpha\nBETA\ngamma\n");
  const dir = join(work, "sub", "dir");
  const made = await tool("forwarder_cli_dir_create", {
    cliDeviceId: deviceId,
    path: dir,
    parents: true,
    confirm: "RUN",
  });
  assert(!made.isError, `mkdir failed: ${made.text}`);
  const listing = await tool("forwarder_cli_dir_list", {
    cliDeviceId: deviceId,
    path: work,
    depth: 3,
  });
  assert.match(listing.result.entries, /renamed\.txt/);
  assert.match(listing.result.entries, /sub\/dir\//);
  const search = await tool("forwarder_cli_file_search", {
    cliDeviceId: deviceId,
    root: work,
    pattern: "BETA",
  });
  assert.match(search.result.matches, /renamed\.txt:2\|BETA/);

  const noConfirm = await tool("forwarder_cli_file_delete", {
    cliDeviceId: deviceId,
    path: renamedPath,
  });
  assert(noConfirm.isError);
  assert.match(noConfirm.text, /DELETE/);
  const deleted = await tool("forwarder_cli_file_delete", {
    cliDeviceId: deviceId,
    path: renamedPath,
    expectedEtag: edited.result.etag,
    confirm: "DELETE",
  });
  assert(!deleted.isError, `delete failed: ${deleted.text}`);
  assert.equal(deleted.result.deleted, true);
  await assert.rejects(readFile(renamedPath), { code: "ENOENT" });

  // ---- protected path and masking ---------------------------------------------
  const protectedWrite = await tool("forwarder_cli_file_write", {
    cliDeviceId: deviceId,
    path: configPath,
    content: "{}",
    ifExists: "replace",
    expectedEtag: "h:AAAAAAAAAAAAAAAAAAAAAA",
    confirm: "RUN",
  });
  assert(protectedWrite.isError);
  assert.equal(protectedWrite.error.code, "path_denied");
  assert.match(await readFile(configPath, "utf8"), /"mcpCommandMode":\s*"unsupervised"/);
  const specialRead = await tool("forwarder_cli_file_read", {
    cliDeviceId: deviceId,
    path: "/proc/self/environ",
  });
  assert(specialRead.isError);
  assert(["path_denied", "special_file"].includes(specialRead.error.code));

  const secretValue = `supersecret-${randomUUID()}`;
  const envPath = join(work, ".env");
  // Secret-class paths are read-only through the tools: creating one is refused too.
  const createEnv = await tool("forwarder_cli_file_write", {
    cliDeviceId: deviceId,
    path: envPath,
    content: `API_TOKEN=${secretValue}\nPUBLIC_NAME=visible\n`,
    confirm: "RUN",
  });
  assert(createEnv.isError);
  assert.equal(createEnv.error.code, "secret_file");
  await assert.rejects(readFile(envPath), { code: "ENOENT" });
  await writeFile(envPath, `API_TOKEN=${secretValue}\nPUBLIC_NAME=visible\n`);
  const masked = await tool("forwarder_cli_file_read", { cliDeviceId: deviceId, path: envPath });
  assert(!masked.isError, `read .env failed: ${masked.text}`);
  assert.match(masked.result.text, /API_TOKEN=⟦redacted:\d+⟧/);
  // Every value of a dotenv file is masked; the names stay visible.
  assert.match(masked.result.text, /PUBLIC_NAME=⟦redacted:7⟧/);
  assert.equal(masked.result.secretFile, true);
  assert(!masked.text.includes(secretValue), "the secret value reached the MCP result");
  const maskedSearch = await tool("forwarder_cli_file_search", {
    cliDeviceId: deviceId,
    root: work,
    pattern: "API_TOKEN",
  });
  assert(!JSON.stringify(maskedSearch).includes(secretValue), "search returned the secret value");
  const overwrite = await tool("forwarder_cli_file_write", {
    cliDeviceId: deviceId,
    path: envPath,
    content: "API_TOKEN=⟦redacted:5⟧\n",
    ifExists: "replace",
    expectedEtag: masked.result.etag,
    confirm: "RUN",
  });
  assert(overwrite.isError, "a masked value must never be written back");
  // The mask token in the content is refused first; either way the file is untouched.
  assert(["secret_file", "redacted_span"].includes(overwrite.error.code));
  for (const [name, args] of [
    [
      "forwarder_cli_file_edit",
      { path: envPath, edits: [{ oldText: "PUBLIC", newText: "X" }], confirm: "RUN" },
    ],
    ["forwarder_cli_file_rename", { from: envPath, to: join(work, "moved.env"), confirm: "RUN" }],
    ["forwarder_cli_file_delete", { path: envPath, confirm: "DELETE" }],
  ]) {
    const refused = await tool(name, { cliDeviceId: deviceId, ...args });
    assert(refused.isError, `${name} on a secret file must be refused`);
    assert.equal(refused.error.code, "secret_file");
  }
  assert.match(await readFile(envPath, "utf8"), new RegExp(secretValue));

  // The relay logs carry no file content and no secret value.
  for (const haystack of [serverLog, relayLog]) {
    assert(!haystack.includes(secretValue), "a secret value leaked into a log");
    assert(!haystack.includes("alpha"), "file content leaked into a log");
  }
  assert.match(relayLog, /file/i, "the CLI did not log the file operations");

  // ---- supervised writes: real E2E terminal keypresses ---------------------
  const sessionId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO session (id, "createdAt", "updatedAt", "expiresAt", token, "userId")
     VALUES ($1, now(), now(), now() + interval '1 hour', $2, $3)`,
    [sessionId, sessionToken, userId],
  );
  const signature = createHmac("sha256", betterAuthSecret).update(sessionToken).digest("base64");
  const cookie = `better-auth.session_token=${encodeURIComponent(`${sessionToken}.${signature}`)}`;
  const restartMode = async (mode) => {
    await waitForExit(relay, "relay mode switch");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ ...config, mcpCommandMode: mode }), {
      mode: 0o600,
    });
    await db.query(`UPDATE cli_device SET "mcpCommandMode" = $1::"McpCommandMode" WHERE id = $2`, [
      mode.toUpperCase(),
      deviceId,
    ]);
    relay = launchRelay();
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (relay.exitCode !== null) throw new Error("relay exited during mode switch");
      const row = await db.query(
        `SELECT status, "reportedMcpCommandMode" FROM cli_device WHERE id = $1`,
        [deviceId],
      );
      if (
        row.rows[0]?.status === "CONNECTED" &&
        row.rows[0]?.reportedMcpCommandMode === mode.toUpperCase()
      )
        return;
      await sleep(100);
    }
    throw new Error("relay mode switch timed out");
  };
  await restartMode("supervised");
  const supervisedDevice = await tool("forwarder_cli_device_get", { cliDeviceId: deviceId });
  assert.equal(supervisedDevice.result.fileTools.write, "supervised");
  const pollFile = async (commandId) => {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      const reply = await tool("forwarder_cli_command_result", { commandId });
      assert(!reply.isError, "file result polling failed");
      if (reply.result.file || reply.result.error) return reply.result;
      await sleep(200);
    }
    throw new Error(
      `supervised file request did not settle\nrelay log tail:\n${relayLog.slice(-3000)}\nserver log tail:\n${serverLog.slice(-3000)}`,
    );
  };
  for (const decision of ["accept", "decline", "stale"]) {
    const targetPath = join(work, `supervised-${decision}.txt`);
    if (decision === "stale") await writeFile(targetPath, "before-preview\n");
    const request = await tool(
      decision === "stale" ? "forwarder_cli_file_edit" : "forwarder_cli_file_write",
      {
        cliDeviceId: deviceId,
        path: targetPath,
        confirm: "RUN",
        reason: "e2e supervised file screen",
        ...(decision === "stale"
          ? { edits: [{ oldText: "before-preview", newText: "approved-change" }] }
          : { content: "approved-change\n" }),
      },
    );
    assert(!request.isError, `supervised start failed: ${request.error?.code}`);
    assert.equal(request.result.status, "awaiting_user");
    assert(request.result.commandId);
    const terminal = await openTerminalTestClient({
      WebSocket,
      serverUrl,
      cookie,
      terminalId: request.result.terminalId,
    });
    try {
      await terminal.waitForScreen(
        (screen) =>
          screen.includes(targetPath) &&
          /Enter/.test(screen) &&
          (decision !== "stale" || screen.includes("before-preview")),
      );
      // Screen contents came from the child and never passed through MCP.
      const waiting = await tool("forwarder_cli_command_result", {
        commandId: request.result.commandId,
      });
      assert.equal(waiting.result.status, "awaiting_user");
      assert.equal(waiting.result.file, undefined);
      if (decision === "stale") await writeFile(targetPath, "changed-after-preview\n");
      // The child flushes type-ahead for 300 ms after drawing, and the daemon
      // forwards no key before its `ready` marker: wait like a person would.
      await sleep(1_000);
      await terminal.keypress(decision === "decline" ? "q" : "\r");
      const done = await pollFile(request.result.commandId).catch((error) => {
        error.message += `\nterminal snapshot: ${JSON.stringify(terminal.snapshot())}`;
        throw error;
      });
      if (decision === "accept") {
        assert.equal(done.file.op, "write");
        assert.equal(done.file.result.created, true);
        assert.equal(done.file.result.diff, undefined);
        assert.equal(await readFile(targetPath, "utf8"), "approved-change\n");
      } else if (decision === "decline") {
        assert.equal(done.error.code, "declined");
        assert.equal(done.error.outcome, undefined);
        await assert.rejects(readFile(targetPath), { code: "ENOENT" });
      } else {
        assert.equal(done.error.code, "conflict");
        assert.equal(done.error.outcome, "unknown");
        assert.equal(await readFile(targetPath, "utf8"), "changed-after-preview\n");
      }
    } finally {
      await terminal.close();
    }
  }
  await restartMode("unsupervised");

  // ---- offline mid-op: freeze the CLI, start a change, kill the CLI -----------
  const target = join(work, "midop.txt");
  await writeFile(target, "one\n");
  const midopEtag = (
    await tool("forwarder_cli_file_stat", { cliDeviceId: deviceId, paths: [target], hash: true })
  ).result.entries[0].etag;
  process.kill(relay.pid, "SIGSTOP");
  const pending = tool("forwarder_cli_file_edit", {
    cliDeviceId: deviceId,
    path: target,
    expectedEtag: midopEtag,
    edits: [{ oldText: "one", newText: "two" }],
    confirm: "RUN",
  });
  await sleep(750);
  process.kill(relay.pid, "SIGKILL");
  const offline = await pending;
  assert(offline.isError);
  assert.equal(offline.error.code, "offline");
  assert.equal(offline.error.outcome, "unknown", "a lost change must report an unknown outcome");
  const afterKill = await readFile(target, "utf8");
  assert(afterKill === "one\n" || afterKill === "two\n", "the file is neither old nor new");
  const stillOffline = await tool("forwarder_cli_file_read", {
    cliDeviceId: deviceId,
    path: target,
  });
  assert(stillOffline.isError);
  assert.equal(stillOffline.error.code, "offline");

  // ---- a 2.3 CLI gets the upgrade message, and the tools say so ----------------
  const upgradeMessage = await new Promise((resolveMessage, reject) => {
    const socket = new WebSocket(
      `${serverUrl.replace("http", "ws")}/api/cli/ws`,
      "ws-model-proxy.relay.v2",
      {
        headers: { authorization: `Bearer ${cliCredential.secret}` },
      },
    );
    let settled = false;
    let challenged = false;
    const finish = (error, frame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolveMessage(frame);
    };
    const timer = setTimeout(() => finish(new Error("no protocol.error for a 2.3 hello")), 10_000);
    socket.on("message", (data) => {
      try {
        const frame = JSON.parse(data.toString());
        if (frame.type === "hello.challenge" && !challenged) {
          challenged = true;
          socket.send(
            JSON.stringify({
              type: "hello",
              id: "hello-old",
              protocolVersion: "2.3",
              cli: { slug: cliSlug, version: "0.4.9", capabilities: { protocolVersion: "2.3" } },
              endpoints: [],
            }),
          );
          return;
        }
        if (!challenged || frame.type !== "protocol.error") {
          finish(new Error("unexpected frame while waiting for old-client refusal"));
          return;
        }
        finish(null, frame);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("socket closed before old-client refusal")));
  });
  assert.equal(upgradeMessage.type, "protocol.error");
  assert(upgradeMessage.message.includes(`relay protocol ${currentProtocol}`));
  assert.match(upgradeMessage.message, /Upgrade wsmp/);
  let rejectedVersion = null;
  const rejectedDeadline = Date.now() + 5_000;
  while (Date.now() < rejectedDeadline && rejectedVersion === null) {
    const row = await db.query(
      `SELECT "rejectedRelayProtocolVersion" FROM cli_device WHERE id = $1`,
      [deviceId],
    );
    rejectedVersion = row.rows[0]?.rejectedRelayProtocolVersion ?? null;
    if (rejectedVersion === null) await sleep(100);
  }
  assert.equal(rejectedVersion, "2.3", "the refused hello was not recorded for the device card");
  const upgrade = await tool("forwarder_cli_file_read", { cliDeviceId: deviceId, path: target });
  assert(upgrade.isError);
  assert.equal(upgrade.error.code, "upgrade_required");
  assert.match(upgrade.text, /relay 2\.3; upgrade wsmp/i);

  // Optional: the same check with a real 2.3 binary.
  const oldBinary = process.env.WSMP_E2E_OLD_CLI_BINARY?.trim();
  if (oldBinary) {
    const old = spawn(resolve(oldBinary), ["connect"], {
      cwd: root,
      env: {
        ...childBaseEnv,
        WSMP_CONFIG: configPath,
        WSMP_STATE_DIR: join(scratch, "old-state"),
        WSMP_E2E_CLI_TOKEN: cliCredential.secret,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let oldLog = "";
    for (const stream of [old.stdout, old.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        oldLog += chunk;
      });
    }
    await Promise.race([
      new Promise((resolveExit) => old.once("exit", resolveExit)),
      sleep(15_000),
    ]);
    if (old.exitCode === null) old.kill("SIGKILL");
    assert(oldLog.includes(`relay protocol ${currentProtocol}`), `old CLI output:\n${oldLog}`);
  }

  if (server.exitCode !== null) throw new Error(`WSMP server exited early:\n${serverLog}`);
  process.stdout.write("file tools relay E2E passed\n");
} finally {
  if (relay) await waitForExit(relay, "relay");
  if (server) await waitForExit(server, "server");
  if (db) {
    await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined); // policy: bounded-delete -- generated test user only
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
