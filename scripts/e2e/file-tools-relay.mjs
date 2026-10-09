import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";
import {
  eventually,
  pg,
  requiredEnv,
  rpcClient,
  signUp,
  startNode,
  startServer,
} from "./lib/stack.mjs";

// End-to-end check of the MCP node file tools (`node_file_read`, `node_file_write`,
// `node_file_edit`): a prebuilt server on an isolated Postgres database, a real `wsmp` node at
// Full control with its file roots set by a person (`wsmp config set-file-roots`), and a Full
// agent token. Setup uses the browser's own paths (sign-up, oRPC, enrollment code).
//
//   WSMP_E2E_DATABASE_URL=postgres://… node scripts/e2e/file-tools-relay.mjs
//
// It needs a built server (apps/server/dist/index.mjs) and a built wsmp
// (apps/cli/target/debug/wsmp); override with WSMP_E2E_SERVER_ENTRY and WSMP_E2E_CLI_BINARY.

const databaseUrl = requiredEnv("WSMP_E2E_DATABASE_URL");
const nodeSlug = `files-${randomUUID().slice(0, 8)}`;
const scratch = await mkdtemp(join(tmpdir(), "wsmp-file-tools-e2e-"));
const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

let db;
let server;
let relay;
let userId;
let failureLogs;
try {
  server = await startServer({ databaseUrl });
  const serverUrl = server.url;
  failureLogs = () => `server:\n${server.log.text}`;
  const person = await signUp(serverUrl, "file-tools-e2e");
  userId = person.userId;
  const client = await rpcClient(serverUrl, person.cookie);
  const work = join(scratch, "work");
  await mkdir(work);
  const node = await startNode({
    client,
    serverUrl,
    scratch: join(scratch, "node"),
    slug: nodeSlug,
    fileRoots: [work],
  });
  relay = node.child;
  failureLogs = () => `server:\n${server.log.text}\nwsmp:\n${node.log.text}`;
  db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const { secret: agentToken } = await client.access.agentTokens.create({
    name: "File tools E2E",
    level: "FULL",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });

  // ---- MCP over HTTP with the agent token ----------------------------------
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
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
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
  /** Calls a tool: `{ isError, result, error, reason, text }` from the in-band result. */
  const tool = async (name, args) => {
    const reply = await mcp("tools/call", { name, arguments: args }, { "mcp-name": name });
    assert(reply.result, `no result for ${name}: ${JSON.stringify(reply)}`);
    const structured = reply.result.structuredContent ?? {};
    return {
      isError: reply.result.isError === true,
      result: structured.result,
      error: structured.error,
      reason: structured.error?.reason,
      text: reply.result.content?.[0]?.text ?? "",
    };
  };
  const nodeId = node.nodeId;
  const read = (args) => tool("node_file_read", { nodeId, ...args });
  const write = (args) => tool("node_file_write", { nodeId, ...args });
  const edit = (args) => tool("node_file_edit", { nodeId, ...args });

  const listed = await mcp("tools/list", {});
  const names = new Set(listed.result.tools.map((entry) => entry.name));
  for (const name of ["node_file_read", "node_file_write", "node_file_edit"])
    assert(names.has(name), `${name} is not listed for a Full agent token`);

  // ---- create -> read -> edit with etag -> stale conflict --------------------
  const notes = join(work, "notes.txt");
  const created = await write({ path: notes, content: "alpha\nbeta\ngamma\n" });
  assert(!created.isError, `write failed: ${created.text}`);
  assert(created.result.etag, "a write returns the new etag");
  assert.equal(await readFile(notes, "utf8"), "alpha\nbeta\ngamma\n");

  const exists = await write({ path: notes, content: "clobber" });
  assert(exists.isError, "a write without ifMatch must not replace a file");
  assert.equal(exists.reason, "exists", exists.text);
  assert.equal(await readFile(notes, "utf8"), "alpha\nbeta\ngamma\n");

  const first = await read({ path: notes });
  assert(!first.isError, `read failed: ${first.text}`);
  assert.equal(first.result.etag, created.result.etag);
  assert.match(JSON.stringify(first.result.result), /alpha/);
  const unchanged = await read({ path: notes, ifNoneMatch: first.result.etag });
  assert(!unchanged.isError, unchanged.text);
  assert.equal(unchanged.result.result.unchanged, true);

  const edited = await edit({
    path: notes,
    ifMatch: first.result.etag,
    edits: [{ old: "beta", new: "BETA", count: 1 }],
    note: "e2e edit",
  });
  assert(!edited.isError, `edit failed: ${edited.text}`);
  assert.notEqual(edited.result.etag, first.result.etag);
  assert.match(edited.result.diff ?? "", /BETA/);
  assert.equal(await readFile(notes, "utf8"), "alpha\nBETA\ngamma\n");

  const stale = await edit({
    path: notes,
    ifMatch: first.result.etag,
    edits: [{ old: "gamma", new: "GAMMA" }],
  });
  assert(stale.isError, "an edit against an old etag must be refused");
  assert.equal(stale.reason, "conflict", stale.text);
  assert.equal(
    await readFile(notes, "utf8"),
    "alpha\nBETA\ngamma\n",
    "a stale edit changed the file",
  );

  const stat = await read({ path: notes, op: "stat" });
  assert(!stat.isError, stat.text);
  assert.equal(stat.result.etag, edited.result.etag);

  // ---- rename, mkdir, list, search, delete ------------------------------------
  const renamedPath = join(work, "renamed.txt");
  const renamed = await write({
    path: notes,
    op: "rename",
    to: renamedPath,
    ifMatch: edited.result.etag,
  });
  assert(!renamed.isError, `rename failed: ${renamed.text}`);
  assert.equal(await readFile(renamedPath, "utf8"), "alpha\nBETA\ngamma\n");
  const made = await write({ path: join(work, "sub", "dir"), op: "mkdir" });
  assert(!made.isError, `mkdir failed: ${made.text}`);
  const listing = await read({ path: work, op: "list", offset: 3 });
  assert(!listing.isError, listing.text);
  assert.match(JSON.stringify(listing.result.result), /renamed\.txt/);
  assert.match(JSON.stringify(listing.result.result), /sub\/dir/);
  const search = await read({ path: work, op: "search", pattern: "BETA" });
  assert(!search.isError, search.text);
  assert.match(JSON.stringify(search.result.result), /renamed\.txt/);
  const deleted = await write({ path: renamedPath, op: "delete", ifMatch: edited.result.etag });
  assert(!deleted.isError, `delete failed: ${deleted.text}`);
  await assert.rejects(readFile(renamedPath), { code: "ENOENT" });

  // ---- outside the roots, wsmp's own files, special files ----------------------
  const outside = await read({ path: join(scratch, "node", "config.json") });
  assert(outside.isError, "a path outside the file roots must be refused");
  assert.equal(outside.reason, "path_denied", outside.text);
  const special = await read({ path: "/proc/self/environ" });
  assert(special.isError);
  assert(["path_denied", "special_file"].includes(special.reason), special.text);

  // ---- secret files: masked on read, never changed ----------------------------
  const secretValue = `supersecret-${randomUUID()}`;
  const envPath = join(work, ".env");
  const createEnv = await write({
    path: envPath,
    content: `API_TOKEN=${secretValue}\nPUBLIC_NAME=visible\n`,
  });
  assert(createEnv.isError, "creating a secret file through the tools must be refused");
  assert.equal(createEnv.reason, "secret_file", createEnv.text);
  await assert.rejects(readFile(envPath), { code: "ENOENT" });
  await writeFile(envPath, `API_TOKEN=${secretValue}\nPUBLIC_NAME=visible\n`);
  const masked = await read({ path: envPath });
  assert(!masked.isError, `read .env failed: ${masked.text}`);
  const maskedText = JSON.stringify(masked.result);
  assert.match(maskedText, /API_TOKEN=⟦redacted:\d+⟧/);
  assert.match(maskedText, /PUBLIC_NAME=⟦redacted:7⟧/);
  assert(!maskedText.includes(secretValue), "the secret value reached the MCP result");
  const maskedSearch = await read({ path: work, op: "search", pattern: "API_TOKEN" });
  assert(!JSON.stringify(maskedSearch).includes(secretValue), "search returned the secret value");
  for (const [label, call] of [
    [
      "write",
      () => write({ path: envPath, content: "API_TOKEN=x\n", ifMatch: masked.result.etag }),
    ],
    [
      "edit",
      () =>
        edit({ path: envPath, ifMatch: masked.result.etag, edits: [{ old: "PUBLIC", new: "X" }] }),
    ],
    ["rename", () => write({ path: envPath, op: "rename", to: join(work, "moved.env") })],
    ["delete", () => write({ path: envPath, op: "delete" })],
  ]) {
    const refused = await call();
    assert(refused.isError, `${label} on a secret file must be refused`);
    assert(["secret_file", "redacted_span"].includes(refused.reason), `${label}: ${refused.text}`);
  }
  assert.match(await readFile(envPath, "utf8"), new RegExp(secretValue));

  // The logs carry no file content and no secret value.
  for (const haystack of [server.log.text, node.log.text]) {
    assert(!haystack.includes(secretValue), "a secret value leaked into a log");
    assert(!haystack.includes("alpha\n"), "file content leaked into a log");
  }

  // ---- offline mid-op: freeze the node, start a change, kill it ----------------
  const target = join(work, "midop.txt");
  await writeFile(target, "one\n");
  const midop = await read({ path: target, op: "stat" });
  process.kill(relay.pid, "SIGSTOP");
  const pending = edit({
    path: target,
    ifMatch: midop.result.etag,
    edits: [{ old: "one", new: "two" }],
  });
  await sleep(750);
  process.kill(-relay.pid, "SIGKILL");
  const offline = await pending;
  assert(offline.isError, "an edit on a node that went away must fail");
  assert.match(JSON.stringify(offline.error), /offline|unknown|node_offline/, offline.text);
  const afterKill = await readFile(target, "utf8");
  assert(afterKill === "one\n" || afterKill === "two\n", "the file is neither old nor new");
  const stillOffline = await read({ path: target });
  assert(stillOffline.isError, "a read on an offline node must fail");

  // ---- Relay only: a person lowers trust in the browser; the tools refuse at once ----
  // The node's disconnect is still being recorded: a concurrent change answers CONFLICT and
  // asks to retry, as the browser does.
  await eventually("lowering trust kept conflicting", () =>
    client.nodes
      .lowerTrust({ nodeId })
      .then(() => true)
      .catch((error) => {
        if (error?.code === "CONFLICT") return false;
        throw error;
      }),
  );
  const lowered = await read({ path: target });
  assert(lowered.isError, "file tools must refuse a node lowered to Relay only");
  assert.equal(lowered.reason, "trust_relay", lowered.text);

  if (server.child.exitCode !== null)
    throw new Error(`WSMP server exited early:\n${server.log.text}`);
  process.stdout.write("file tools relay E2E passed\n");
} catch (error) {
  if (process.env.WSMP_E2E_VERBOSE && failureLogs) process.stderr.write(failureLogs());
  throw error;
} finally {
  if (relay) await waitForExit(relay, "wsmp");
  if (server) await waitForExit(server.child, "server");
  if (db) {
    if (userId) await db.query(`DELETE FROM "user" WHERE id = $1`, [userId]).catch(() => undefined); // policy: bounded-delete -- generated test user only
    await db.end();
  }
  await rm(scratch, { recursive: true, force: true });
}
