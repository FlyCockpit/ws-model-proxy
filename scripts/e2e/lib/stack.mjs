// Shared setup for the 0.4.0 full-stack e2e harnesses: a prebuilt WMP server on an isolated,
// schema-ready Postgres database, a person signed up through Better Auth (browser session),
// the oRPC API with that session, and a real `wsmp` node enrolled with an enrollment code.
// Everything goes through production paths; nothing is seeded with SQL.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

export const root = resolve(import.meta.dirname, "../../..");

// `pg` is an existing @ws-model-proxy/db dependency and the oRPC client one of apps/web:
// resolve them from those workspaces instead of adding root dependencies for the tests.
const requireFromDb = createRequire(join(root, "packages/db/package.json"));
const requireFromWeb = createRequire(join(root, "apps/web/package.json"));
export const pg = requireFromDb("pg");
const importFromWeb = (specifier) => import(pathToFileURL(requireFromWeb.resolve(specifier)).href);

export function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function freePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const address = probe.address();
  assert(address && typeof address === "object");
  await new Promise((resolveClose) => probe.close(resolveClose));
  return address.port;
}

/** Only these variables reach child processes. */
export const childBaseEnv = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "SystemRoot"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);

function captured(child) {
  const log = { text: "" };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      log.text += chunk;
    });
  }
  return log;
}

/** Start the prebuilt server. Sign-up stays open so the harness can create its person. */
export async function startServer({ databaseUrl, extraEnv = {} }) {
  const serverEntry = resolve(process.env.WSMP_E2E_SERVER_ENTRY || "apps/server/dist/index.mjs");
  await access(serverEntry);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    detached: process.platform !== "win32",
    env: {
      ...childBaseEnv,
      WSMP_DISABLE_DOTENV: "1",
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      SERVER_PORT: String(port),
      BETTER_AUTH_SECRET: randomBytes(48).toString("base64url"),
      BETTER_AUTH_URL: url,
      SIGNUP_ENABLED: "true",
      // The harness polls the API while waiting; keep the built-in limits out of its way.
      WMP_RATE_LIMIT_SCALE: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = captured(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`WSMP server exited early:\n${log.text}`);
    const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) })
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) return { child, url, log };
    await sleep(200);
  }
  throw new Error(`WSMP server did not answer /health within 30s:\n${log.text}`);
}

/** Sign a fresh person up (no SMTP: no verification) and return the session cookie. */
export async function signUp(serverUrl, label) {
  const email = `${label}-${randomUUID()}@invalid.test`;
  const response = await fetch(`${serverUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: serverUrl },
    body: JSON.stringify({
      email,
      password: `e2e-${randomBytes(18).toString("base64url")}`,
      name: label,
    }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `sign-up failed: ${body}`);
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  assert(cookie.length > 0, "sign-up set no session cookie");
  return { email, userId: JSON.parse(body).user.id, cookie };
}

/** The oRPC client a signed-in browser uses (session cookie plus the CSRF header). */
export async function rpcClient(serverUrl, cookie) {
  const { createORPCClient } = await importFromWeb("@orpc/client");
  const { RPCLink } = await importFromWeb("@orpc/client/fetch");
  const { SimpleCsrfProtectionLinkPlugin } = await importFromWeb("@orpc/client/plugins");
  const link = new RPCLink({
    url: `${serverUrl}/rpc`,
    headers: () => ({ cookie }),
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
  });
  return createORPCClient(link);
}

/**
 * Enroll a real `wsmp` node with a fresh enrollment code (Full control, no service, no
 * browser terminals), then run its relay in the foreground. Resolves once the server shows the
 * node online.
 */
export async function startNode({ client, serverUrl, scratch, slug }) {
  const cliBinary = resolve(process.env.WSMP_E2E_CLI_BINARY || "apps/cli/target/debug/wsmp");
  await access(cliBinary);
  const env = {
    ...childBaseEnv,
    WSMP_CONFIG: join(scratch, "config.json"),
    WSMP_STATE_DIR: join(scratch, "state"),
  };
  const { secret } = await client.nodes.enrollmentCodes.create({ suggestedSlug: slug });
  const login = spawn(
    cliBinary,
    [
      "login",
      serverUrl,
      "--code",
      secret,
      "--slug",
      slug,
      "--trust",
      "full",
      "--human-terminal",
      "off",
      "--no-service",
      "--yes",
    ],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const loginLog = captured(login);
  const loginCode = await new Promise((resolveExit) => login.once("exit", resolveExit));
  assert.equal(loginCode, 0, `wsmp login failed:\n${loginLog.text}`);

  const child = spawn(cliBinary, process.env.WSMP_E2E_VERBOSE ? ["-v", "run"] : ["run"], {
    cwd: root,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = captured(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wsmp exited early:\n${log.text}`);
    const { nodes } = await client.nodes.list();
    const node = nodes.find((candidate) => candidate.slug === slug);
    if (node?.connection === "ONLINE") return { child, log, nodeId: node.id };
    await sleep(250);
  }
  throw new Error(`node ${slug} did not come online within 30s:\n${log.text}`);
}

/** Wait until `check` returns a truthy value (polled), or fail with `label`. */
export async function eventually(label, check, { timeoutMs = 30_000, intervalMs = 250 } = {}) {
  if (process.env.WSMP_E2E_VERBOSE) process.stderr.write(`waiting: ${label.split("\n")[0]}\n`);
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label} within ${timeoutMs} ms`);
}

/** Every served model of an always-on runtime is listed and its instance is ready. */
export async function waitForReadyRuntime(client, runtimeId, logs) {
  return eventually(
    `runtime ${runtimeId} was not ready`,
    async () => {
      const runtime = await client.runtimes.get({ runtimeId });
      const ready = runtime.instanceList.some((instance) => instance.phase === "READY");
      return ready ? runtime : null;
    },
    { timeoutMs: 60_000, intervalMs: 1_000 },
  ).catch((error) => {
    throw new Error(`${error.message}\n${logs()}`);
  });
}
