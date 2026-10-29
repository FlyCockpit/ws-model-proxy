import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForExit } from "../lib/wait-for-exit.mjs";
import {
  eventually,
  pg,
  requiredEnv,
  root,
  rpcClient,
  signUp,
  startNode,
  startServer,
} from "./lib/stack.mjs";

// End-to-end check of the browser node event stream (#255): a prebuilt server on an isolated
// Postgres database, two people signed in through Better Auth, and a real `wsmp` node of the
// first. Each person holds `GET /api/dashboard/events` open as a browser tab does; the script
// enrolls, lowers trust, stops, restarts and deletes the node, then signs out, and checks what
// each stream heard and when.
//
//   WSMP_E2E_DATABASE_URL=postgres://… node scripts/e2e/node-presence.mjs
//
// It needs a built server (apps/server/dist/index.mjs) and a built wsmp
// (apps/cli/target/debug/wsmp); override with WSMP_E2E_SERVER_ENTRY and WSMP_E2E_CLI_BINARY.

const databaseUrl = requiredEnv("WSMP_E2E_DATABASE_URL");
const nodeSlug = `presence-${randomUUID().slice(0, 8)}`;
const scratch = await mkdtemp(join(tmpdir(), "wsmp-node-presence-e2e-"));

/** A browser tab's stream: every SSE event it got, in order, and whether it ended. */
async function openStream(serverUrl, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${serverUrl}/api/dashboard/events`, {
    headers: { cookie, accept: "text/event-stream", "sec-fetch-site": "same-origin" },
    signal: controller.signal,
  });
  // Read the body only on a refusal: a 200's body is the endless stream.
  if (response.status !== 200)
    assert.fail(`stream refused: ${response.status} ${await response.text()}`);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream/);
  const stream = { events: [], ended: false, close: () => controller.abort() };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end = buffer.indexOf("\n\n");
        while (end !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = block.split("\n");
          const name = lines.find((line) => line.startsWith("event: "))?.slice(7);
          const data = lines
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (name) stream.events.push({ event: name, data: data ? JSON.parse(data) : null });
          end = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // Aborted by the script.
    }
    stream.ended = true;
  })();
  return stream;
}

const nodeEvents = (stream) =>
  stream.events.filter((entry) => entry.event === "node").map((entry) => entry.data);

/** Waits for a node event matching `match` after index `from`; returns its index. */
function nextEvent(stream, from, match, label) {
  return eventually(
    label,
    () => {
      const index = nodeEvents(stream).findIndex((event, at) => at >= from && match(event));
      return index === -1 ? null : index + 1;
    },
    { timeoutMs: 20_000, intervalMs: 50 },
  );
}

let db;
let server;
let relay;
let userIds = [];
let failureLogs;
try {
  server = await startServer({ databaseUrl });
  const serverUrl = server.url;
  failureLogs = () => `server:\n${server.log.text}`;
  const owner = await signUp(serverUrl, "presence-e2e");
  const other = await signUp(serverUrl, "presence-other");
  userIds = [owner.userId, other.userId];
  const client = await rpcClient(serverUrl, owner.cookie);

  // ---- refusals before any stream -------------------------------------------------------------
  const anonymous = await fetch(`${serverUrl}/api/dashboard/events`);
  assert.equal(anonymous.status, 401, "a stream without a session is refused");
  const crossSite = await fetch(`${serverUrl}/api/dashboard/events`, {
    headers: { cookie: owner.cookie, origin: "https://evil.example.test" },
  });
  assert.equal(crossSite.status, 403, "another site's page cannot open the stream");

  const ownerStream = await openStream(serverUrl, owner.cookie);
  const otherStream = await openStream(serverUrl, other.cookie);
  await eventually("no hello", () => ownerStream.events.some((entry) => entry.event === "hello"));

  // ---- enroll and connect: node.added, then ONLINE ----------------------------------------------
  const node = await startNode({
    client,
    serverUrl,
    scratch: join(scratch, "node"),
    slug: nodeSlug,
  });
  relay = node.child;
  const nodeId = node.nodeId;
  failureLogs = () => `server:\n${server.log.text}\nwsmp:\n${node.log.text}`;
  let seen = await nextEvent(
    ownerStream,
    0,
    (event) => event.type === "node.added" && event.nodeId === nodeId,
    "no node.added after enrollment",
  );
  seen = await nextEvent(
    ownerStream,
    seen,
    (event) =>
      event.type === "node.connection" && event.nodeId === nodeId && event.connection === "ONLINE",
    "no ONLINE after the node connected",
  );
  const firstGeneration = nodeEvents(ownerStream)[seen - 1].generation;
  assert(Number.isInteger(firstGeneration) && firstGeneration >= 1, "ONLINE carries a generation");

  // ---- lowering trust: node.trust, and the node still reconnects after it (#258) ----------------
  await eventually("lowering trust kept conflicting", () =>
    client.nodes
      .lowerTrust({ nodeId })
      .then(() => true)
      .catch((error) => {
        if (error?.code === "CONFLICT") return false;
        throw error;
      }),
  );
  seen = await nextEvent(
    ownerStream,
    seen,
    (event) => event.type === "node.trust" && event.nodeId === nodeId,
    "no node.trust after lowering trust",
  );

  // ---- stop: OFFLINE, and the list already says so ------------------------------------------------
  await waitForExit(relay, "wsmp");
  relay = null;
  seen = await nextEvent(
    ownerStream,
    seen,
    (event) =>
      event.type === "node.connection" && event.nodeId === nodeId && event.connection === "OFFLINE",
    "no OFFLINE after the node stopped",
  );
  const listed = await client.nodes.list();
  assert.equal(
    listed.nodes.find((candidate) => candidate.id === nodeId)?.connection,
    "OFFLINE",
    "a refetch right after the OFFLINE event reads OFFLINE",
  );

  // ---- restart: ONLINE with a newer generation -----------------------------------------------
  relay = spawn(node.cliBinary, ["run"], {
    cwd: root,
    detached: process.platform !== "win32",
    env: node.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  seen = await nextEvent(
    ownerStream,
    seen,
    (event) =>
      event.type === "node.connection" && event.nodeId === nodeId && event.connection === "ONLINE",
    "no ONLINE after the node restarted",
  );
  assert(
    nodeEvents(ownerStream)[seen - 1].generation > firstGeneration,
    "a reconnect carries a newer generation",
  );

  // ---- delete: node.removed ----------------------------------------------------------------------
  await eventually("deleting the node kept conflicting", () =>
    client.nodes
      .delete({ nodeId })
      .then(() => true)
      .catch((error) => {
        if (error?.code === "CONFLICT") return false;
        throw error;
      }),
  );
  seen = await nextEvent(
    ownerStream,
    seen,
    (event) => event.type === "node.removed" && event.nodeId === nodeId,
    "no node.removed after deleting the node",
  );

  // ---- another person heard nothing of it -------------------------------------------------------
  assert.deepEqual(nodeEvents(otherStream), [], "another person's stream got node events");
  assert.equal(otherStream.ended, false, "another person's stream stayed open");

  // ---- sign-out closes the stream at once -----------------------------------------------------------
  const signedOutAt = Date.now();
  const signOut = await fetch(`${serverUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: { cookie: owner.cookie, origin: serverUrl, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(signOut.status, 200, `sign-out failed: ${await signOut.text()}`);
  await eventually("the stream stayed open after sign-out", () => ownerStream.ended, {
    timeoutMs: 5_000,
    intervalMs: 20,
  });
  assert(Date.now() - signedOutAt < 2_000, "sign-out closed the stream within 2 s");
  assert.deepEqual(ownerStream.events.at(-1), {
    event: "unauthorized",
    data: { reason: "session_ended" },
  });
  const afterSignOut = await fetch(`${serverUrl}/api/dashboard/events`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(afterSignOut.status, 401, "a signed-out session cannot reopen the stream");
  otherStream.close();

  if (server.child.exitCode !== null)
    throw new Error(`WSMP server exited early:\n${server.log.text}`);
  process.stdout.write(
    `node presence E2E passed (${nodeEvents(ownerStream).length} node events)\n`,
  );
} catch (error) {
  if (process.env.WSMP_E2E_VERBOSE && failureLogs) process.stderr.write(failureLogs());
  throw error;
} finally {
  if (relay) await waitForExit(relay, "wsmp");
  if (server) await waitForExit(server.child, "server");
  db = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  for (const id of userIds)
    await db.query(`DELETE FROM "user" WHERE id = $1`, [id]).catch(() => undefined); // policy: bounded-delete -- generated test user only
  await db.end();
  await rm(scratch, { recursive: true, force: true });
}
