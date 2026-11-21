#!/usr/bin/env node
// Invoked only through test-adopt-released.sh's local-only URL guard.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { testContainerPrefix } from "../lib/test-container-prefix.mjs";
import { diffCatalogs, readSchemaCatalog, UPGRADE_MIGRATION } from "./lib/baseline.mjs";
import { withDatabase } from "./lib/local-db-name.mjs";
import { pgConnectionString } from "./lib/migration-state.mjs";
import { loadPg, ROOT } from "./lib/prisma.mjs";
import { adminClient, createDatabase, removeDatabase } from "./lib/scratch-db.mjs";

const pg = loadPg();
const serverUrl = process.env.DATABASE_URL;
const suffix = randomBytes(8).toString("hex");
const names = [`wmp_test_${suffix}`, `wmp_test_${suffix}f`];
// The released image's container: `<prefix>-fx-release-<hex>`, the prefix from
// `--container-prefix <name>`, else TEST_CONTAINER_PREFIX, else the shared
// default `wmp` (scripts/lib/test-container-prefix.mjs).
const container = `${testContainerPrefix({ argv: process.argv.slice(2) })}-fx-release-${suffix}`;
const temp = await mkdtemp(path.join(tmpdir(), "wmp-adopt-released-"));
const created = [];
let admin;
let containerAttempted = false;
let interrupted = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    interrupted = true;
  });

// Never inherit a configured backup destination or identity from the operator.
const runnerEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith("BACKUP_") && key !== "WMP_INSTANCE_ID",
  ),
);
async function command(executable, args, env = runnerEnv, timeout = 240_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Do not echo Docker/Prisma output: it may contain the temporary URL.
      if (code !== 0)
        reject(
          new Error(
            `${executable} failed (exit ${code}); output withheld to protect temporary credentials.`,
          ),
        );
      else resolve(output);
    });
  });
}
async function withClient(url, work) {
  const client = new pg.Client({ connectionString: pgConnectionString(url) });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}
async function catalog(url) {
  return await withClient(url, async (client) => {
    await client.query("BEGIN");
    try {
      return await readSchemaCatalog(client, "public");
    } finally {
      await client.query("ROLLBACK");
    }
  });
}
try {
  // Also guard direct invocation of this .mjs entry point.
  await command("bash", ["scripts/assert-local-database.sh", "db:test-adopt-released"]);
  admin = await adminClient(pg, serverUrl);
  for (const name of names) {
    assert.equal(await createDatabase(admin, name), true, "scratch database must be new");
    created.push(name);
  }
  const [releasedUrl, freshUrl] = names.map((name) => withDatabase(serverUrl, name));
  const envFile = path.join(temp, "released.env");
  await writeFile(
    envFile,
    [
      `DATABASE_URL=${releasedUrl}`,
      "APPLY_SCHEMA=safe",
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("hex")}`,
      `WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS=${randomBytes(32).toString("base64")}`,
      "BETTER_AUTH_URL=http://localhost:3000",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  containerAttempted = true;
  await command("docker", [
    "run",
    "-d",
    "--name",
    container,
    "--network",
    "host",
    "--env-file",
    envFile,
    "ghcr.io/flycockpit/ws-model-proxy:v0.4.3",
    "sleep",
    "300",
  ]);
  console.log(`Released schema sync running in ${container} (temporary credentials withheld).`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (interrupted) throw new Error("released adoption test interrupted");
    const logs = await command("docker", ["logs", container]);
    if (/Schema sync complete\./.test(logs)) break;
    if (Date.now() > deadline)
      throw new Error("released image did not complete schema sync within 180 s");
    const running = await command("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}",
      container,
    ]);
    if (running.trim() !== "true")
      throw new Error("released image exited before schema sync completed");
    await delay(1000);
  }
  await command("docker", ["stop", "--time", "10", container]);
  // Managed providers commonly put extensions in public. Their objects must
  // not prevent adopting the application schema or comparing the upgrade.
  await withClient(releasedUrl, async (client) => {
    for (const name of ["pgcrypto", "pg_trgm", "pg_stat_statements"])
      await client.query(`CREATE EXTENSION ${client.escapeIdentifier(name)} SCHEMA public`);
  });
  const upgraded = await command(
    process.execPath,
    ["scripts/db/migrate-runtime.mjs", "apply", "--role", "server"],
    { ...runnerEnv, DATABASE_URL: releasedUrl },
  );
  assert.match(upgraded, /adopted a v0\.4\.3 database/);
  assert.ok(
    upgraded.includes(`Applying migration \`${UPGRADE_MIGRATION}\``),
    "upgrade must actually run",
  );
  assert.match(upgraded, /database is up to date/);
  await command(process.execPath, ["scripts/db/migrate-runtime.mjs", "apply", "--role", "server"], {
    ...runnerEnv,
    DATABASE_URL: freshUrl,
  });
  const [live, expected] = await Promise.all([catalog(releasedUrl), catalog(freshUrl)]);
  assert.deepEqual(diffCatalogs(expected, live), { missing: [], unexpected: [] });
  console.log(
    `PASS: released v0.4.3 adopted, upgrade applied, catalog identical to fresh (${expected.length} rows; provider extensions ignored).`,
  );
} catch (error) {
  // Keep messages/assertions useful without printing generated URLs or secrets.
  console.error(
    error instanceof assert.AssertionError
      ? `FAIL: ${error.message.split("\n")[0]}`
      : `FAIL: ${error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "<url>") : "adoption test failed"}`,
  );
  process.exitCode = 1;
} finally {
  try {
    if (containerAttempted) {
      try {
        await command("docker", ["rm", "-f", container]);
        console.log(`Removed container ${container}.`);
      } catch {
        console.error(
          `Cleanup: verify container ${container} was removed (Docker run may have failed before creation).`,
        );
        process.exitCode = 1;
      }
    }
    if (admin) {
      try {
        for (const name of created) await removeDatabase(admin, name, { kind: "scratch" });
      } finally {
        await admin.end();
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
