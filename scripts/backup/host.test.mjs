import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { linuxOnlyTest } from "./linux-only.mjs";

// host.sh is Linux-only (the Docker host): see linux-only.mjs.
const test = linuxOnlyTest(import.meta.url);

const host = resolve("scripts/backup/host.sh");

/** Real bash functions, inert Docker boundary; only disposable fake credentials. */
function run(
  body,
  {
    projects = "alpha\n",
    restoreExit = "0",
    volume = "alpha-backups",
    stopExit = "0",
    stopFailOn = "",
    restoreSignal = "",
    imageGone = false,
    workingDir = undefined,
    configFiles = "/srv/wmp/compose.yaml,/srv/wmp/compose.backups.yaml",
    envFiles = "<no value>",
    markOnStop = false,
    stopSignal = "",
    apps = "app-app",
    databases = "app-postgres",
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "backup-host-test-"));
  const log = join(dir, "calls.jsonl");
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
for ((index=1; index<=$#; index++)); do
  if [ "\${!index}" = --env-file ]; then
    next=$((index + 1))
    export HOST_TEST_CAPTURED_ENV="$(cat "\${!next}")"
  fi
done
exec node "$(dirname "$0")/docker-stub.cjs" "$@"
`,
  );
  writeFileSync(
    join(dir, "docker-stub.cjs"),
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
const call = { args };
const index = args.indexOf("--env-file");
if (index !== -1) {
  call.envPath = args[index + 1];
  call.env = process.env.HOST_TEST_CAPTURED_ENV;
}
fs.appendFileSync(process.env.HOST_TEST_LOG, JSON.stringify(call) + "\\n");
const text = args.join(" ");
if (args[0] === "ps") {
  // The shipped compose.yaml names the app service \`app\`: only that filter
  // finds the app (any other service name finds nothing).
  if (/service=(?!(app|postgres)( |$))/.test(text)) {}
  else if (args.includes("--format")) process.stdout.write(text.includes("service=app") ? process.env.HOST_TEST_PROJECTS : "");
  else if (text.includes("service=app")) {
    // Stopped containers (named *-run-*) are listed only with -a.
    const apps = (process.env.HOST_TEST_APPS || "").split("\\n").filter((id) => id && (args.includes("-a") || !id.includes("-run-")));
    process.stdout.write(apps.map((id) => id + "\\n").join(""));
  }
  else if (text.includes("service=postgres")) {
    const databases = (process.env.HOST_TEST_DATABASES || "").split("\\n").filter((id) => id && (args.includes("-a") || !id.includes("-run-")));
    process.stdout.write(databases.map((id) => id + "\\n").join(""));
  }
  else console.log("app-app\\napp-worker\\napp-backup\\napp-postgres\\napp-redis");
} else if (args[0] === "inspect") {
  const format = args[2];
  const id = args[3];
  if (format === "{{.Name}} ({{.State.Status}})") console.log("/" + id + (id.includes("-run-") ? " (exited)" : " (running)"));
  else if (format === "{{.Image}}") console.log("app-image");
  else if (format === "{{.Config.Image}}") console.log("postgres:18");
  else if (format.includes(".Mounts")) console.log(process.env.HOST_TEST_VOLUME);
  else if (format.includes(".NetworkSettings")) console.log("dokploy-network alpha_default");
  else if (format.includes("working_dir") && process.env.HOST_TEST_WORKING_DIR !== undefined) console.log(process.env.HOST_TEST_WORKING_DIR);
  else if (format.includes("config_files")) console.log(process.env.HOST_TEST_CONFIG_FILES);
  else if (format.includes("environment_file")) console.log(process.env.HOST_TEST_ENV_FILES);
  else if (format.includes(".Config.Labels")) console.log(id.replace("app-", ""));
  else if (format.includes(".State.Running")) console.log(id.includes("-run-") ? "false" : "true");
  else if (format.includes(".Config.Env")) fs.writeSync(1, "DATABASE_URL=" + "postgresql://fake:fake@db/app\\nBACKUP_S3_BUCKET=fake-backups\\nBACKUP_S3_SECRET_ACCESS_KEY=fake-secret\\nS3_ACCESS_KEY_ID=fake-upload-key\\nUNRELATED_SECRET=must-not-pass\\n");
} else if (args[0] === "image" && args[1] === "inspect") {
  if (process.env.HOST_TEST_IMAGE_GONE) {
    console.error("Error response from daemon: No such image: " + args.at(-1));
    process.exitCode = 1;
  }
} else if (args[0] === "stop") {
  // Once: the first stop (after the stop prompt) is interrupted by a signal.
  const signalled = process.env.HOST_TEST_LOG + ".signalled";
  if (process.env.HOST_TEST_STOP_SIGNAL && !fs.existsSync(signalled)) {
    fs.writeFileSync(signalled, "");
    process.kill(process.ppid, process.env.HOST_TEST_STOP_SIGNAL);
  }
  if (process.env.HOST_TEST_MARK) fs.writeFileSync(process.env.HOST_TEST_MARK, "");
  process.exitCode = !process.env.HOST_TEST_STOP_FAIL_ON || args.at(-1) === process.env.HOST_TEST_STOP_FAIL_ON ? Number(process.env.HOST_TEST_STOP_EXIT) : 0;
} else if (args[0] === "run" && args.includes("restore") && args.includes("--guided")) {
  if (process.env.HOST_TEST_RESTORE_SIGNAL) process.kill(process.ppid, process.env.HOST_TEST_RESTORE_SIGNAL);
  process.exitCode = Number(process.env.HOST_TEST_RESTORE_EXIT);
}
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  // Node starts children with SIGPIPE ignored; a terminal shell has it at the
  // default (fatal), so restore that before bash starts (GNU env, Linux-only).
  const result = spawnSync(
    "env",
    ["--default-signal=PIPE", "bash", "-c", 'source "$1"\n' + body, "host-test", host],
    {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        HOST_TEST_LOG: log,
        HOST_TEST_PROJECTS: projects,
        HOST_TEST_RESTORE_EXIT: restoreExit,
        HOST_TEST_VOLUME: volume,
        HOST_TEST_STOP_EXIT: stopExit,
        HOST_TEST_STOP_SIGNAL: stopSignal,
        HOST_TEST_STOP_FAIL_ON: stopFailOn,
        HOST_TEST_RESTORE_SIGNAL: restoreSignal,
        ...(imageGone ? { HOST_TEST_IMAGE_GONE: "1" } : {}),
        ...(workingDir === undefined ? {} : { HOST_TEST_WORKING_DIR: workingDir }),
        HOST_TEST_CONFIG_FILES: configFiles,
        HOST_TEST_ENV_FILES: envFiles,
        HOST_TEST_APPS: apps,
        HOST_TEST_DATABASES: databases,
        ...(markOnStop ? { HOST_TEST_MARK: join(dir, "stopped") } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
      // SIGKILL: a regression that traps SIGTERM cannot outlive the timeout.
      killSignal: "SIGKILL",
    },
  );
  const calls = (() => {
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  })();
  const files = readdirSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return { ...result, calls, files };
}

test("host can be sourced without discovering or changing anything", () => {
  const result = run(":");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls, []);
});

test("host prints usage with no arguments: run, sourced, or piped into bash -s (exit 2)", () => {
  // Run as a file: the help is the file's header.
  const file = spawnSync("bash", [host], { encoding: "utf8" });
  assert.equal(file.status, 2, file.stderr);
  assert.match(file.stdout, /bash app-db\.sh restore \[<backup>\]/);
  assert.match(file.stdout, /hold-deletions/);
  assert.equal(file.stderr, "");
  // Sourced ($0 is the caller, not this file): still this file's header.
  const sourced = run("main");
  assert.equal(sourced.status, 2, sourced.stderr);
  assert.match(sourced.stdout, /bash app-db\.sh restore \[<backup>\]/);
  assert.equal(sourced.stderr, "");
  assert.deepEqual(sourced.calls, []);
  // Piped into `bash -s` there is no source file: a one-line usage instead.
  const piped = spawnSync("bash", ["-s"], { input: readFileSync(host, "utf8"), encoding: "utf8" });
  assert.equal(piped.status, 2, piped.stderr);
  assert.match(
    piped.stderr,
    /^Usage: bash <this script> list \| backup \| restore \| drill \| hold-deletions/,
  );
  assert.doesNotMatch(piped.stderr, /sed:|No such file|unbound variable/);
});

test("host rejects an unknown command and an incomplete --project before Docker", () => {
  for (const [args, message] of [
    ["unknown", /unknown command/],
    ["list --project", /needs a name/],
  ]) {
    const result = run(`main ${args}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
    assert.deepEqual(result.calls, []);
  }
});

test("host refuses Docker results missing compose project labels", () => {
  const result = run("main list", { projects: "\n<no value>\n" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no app found/);
});

test("host needs exactly one app container in the project: none or several refuse before anything else", () => {
  const docker = (result) =>
    result.calls.filter((call) => !["ps", "inspect", "info"].includes(call.args[0]));
  // One: found and used, also when it is stopped (after a restore that left it stopped).
  const one = run("main list --project alpha");
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /app container app-app,/);
  const stopped = run("main list --project alpha", { apps: "app-app-run-1f2e" });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.match(stopped.stdout, /app container app-app-run-,/);
  // None: refused.
  const none = run("main restore daily.dump --project alpha", { apps: "" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no app container in "alpha"/);
  assert.deepEqual(docker(none), []);
  // Several (a replica, a leftover `docker compose run`): refused, naming each one,
  // before any image check, one-off container, stop or start.
  for (const command of ["list", "backup", "restore daily.dump", "drill"]) {
    const several = run(
      `require_terminal() { return 0; }\nask() { return 0; }\nmain ${command} --project alpha`,
      { apps: "app-app\napp-app-run-1f2e" },
    );
    assert.equal(several.status, 1, command);
    assert.match(several.stderr, /"alpha" has 2 app containers; this helper needs exactly one/);
    assert.match(several.stderr, /app-app \(running\)\n\s+app-app-run-1f2e \(exited\)/);
    assert.match(several.stderr, /docker rm -f <name>/);
    assert.deepEqual(docker(several), [], command);
    assert.doesNotMatch(several.stdout, /app container/);
  }
});

test("host needs exactly one postgres container in the project: none or several refuse before anything else", () => {
  const docker = (result) =>
    result.calls.filter((call) => !["ps", "inspect", "info"].includes(call.args[0]));
  // One: found also when it is stopped (listed with -a)...
  const stoppedList = run("main list --project alpha", { databases: "app-postgres-run-9a" });
  assert.equal(stoppedList.status, 0, stoppedList.stderr);
  // ...and it is the one restore checks: stopped, so restore refuses before stopping anything.
  const stopped = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { databases: "app-postgres-run-9a" },
  );
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stderr, /the database container is not running/);
  assert.ok(
    stopped.calls.some(
      (call) =>
        call.args[0] === "inspect" &&
        call.args[2] === "{{.State.Running}}" &&
        call.args.at(-1) === "app-postgres-run-9a",
    ),
  );
  assert.deepEqual(
    stopped.calls.filter((call) => ["run", "stop", "start"].includes(call.args[0])),
    [],
  );
  for (const command of ["list", "backup", "restore daily.dump", "drill"]) {
    const script = `require_terminal() { return 0; }\nask() { return 0; }\nmain ${command} --project alpha`;
    // None: refused.
    const none = run(script, { databases: "" });
    assert.equal(none.status, 1, command);
    assert.match(none.stderr, /no postgres container in "alpha"/);
    assert.match(none.stderr, /needs exactly one and changed nothing/);
    assert.deepEqual(docker(none), [], command);
    assert.doesNotMatch(none.stdout, /app container/);
    // Several (a leftover `docker compose run`): refused, naming each one, before
    // any image check, one-off container, stop or start.
    const several = run(script, { databases: "app-postgres\napp-postgres-run-1f2e" });
    assert.equal(several.status, 1, command);
    assert.match(
      several.stderr,
      /"alpha" has 2 postgres containers; this helper needs exactly one/,
    );
    assert.match(several.stderr, /app-postgres \(running\)\n\s+app-postgres-run-1f2e \(exited\)/);
    assert.match(several.stderr, /docker rm -f <name>/);
    assert.match(several.stderr, /never its data volume/);
    assert.deepEqual(docker(several), [], command);
    assert.doesNotMatch(several.stdout, /app container/);
  }
});

test("host offers matching projects and discovers the selected container, volume and private network", () => {
  const result = run("choose_project() { pick=2; }\nmain list", {
    projects: "beta\nalpha\nalpha\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1\) alpha[\s\S]*2\) beta/);
  const runCall = result.calls.find((call) => call.args[0] === "run");
  assert.ok(
    result.calls.some((call) => call.args.includes("label=com.docker.compose.project=beta")),
  );
  assert.ok(runCall.args.includes("alpha_default"));
  assert.ok(runCall.args.includes("alpha-backups:/backups"));
  assert.ok(runCall.args.includes("app-image"));
  assert.deepEqual(runCall.args.slice(-2), ["restore", "--list"]);
});

test("host forwards only backup settings through an --env-file process substitution", () => {
  const result = run("main backup --project alpha");
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.envPath);
  assert.match(call.envPath, /^\/(dev\/fd|proc\/self\/fd)\/\d+$/);
  assert.match(call.env, /DATABASE_URL=postgresql:\/\/fake/);
  assert.match(call.env, /BACKUP_S3_SECRET_ACCESS_KEY=fake-secret/);
  assert.match(call.env, /S3_ACCESS_KEY_ID=fake-upload-key/);
  assert.doesNotMatch(call.env, /UNRELATED_SECRET/);
  assert.deepEqual(result.files.sort(), ["calls.jsonl", "docker", "docker-stub.cjs"]);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-secret|postgresql:/);
});

test("host starts the app again after a successful restore (stop, restore, then stop-then-start)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions
      .filter((call) => call.args[0] === "stop")
      .slice(0, 3)
      .map((call) => call.args.at(-1)),
    ["app-app", "app-worker", "app-backup"],
  );
  const restore = actions.find((call) => call.args[0] === "run");
  assert.deepEqual(restore.args.slice(-3), ["restore", "/backups/daily.dump", "--guided"]);
  // The outcome is reported on stderr (a `| tee` reader may be gone).
  assert.match(result.stderr, /Restore done/);
  assert.match(result.stderr, /pending migrations/);
  assert.doesNotMatch(result.stderr, /uncertain|nothing was changed/i);
});

test("host leaves all writers stopped after an ambiguous failed restore", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "7" },
  );
  assert.equal(result.status, 7, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    ["stop", "stop", "stop", "run"],
  );
  assert.match(
    result.stderr,
    /Restore failed and its outcome is uncertain, or it committed and a later step failed \(exit 7\): the restore output above says which\. The app stays stopped/,
  );
  assert.match(result.stderr, /docker start app-app app-worker app-backup/);
  assert.doesNotMatch(
    result.stderr,
    /Nothing was restored|database is as it was|nothing was changed|Restore done/i,
  );
});

test("host exits 3 and stops nothing when the operator declines to stop the app", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 1; }\nmain restore daily.dump --project alpha",
  );
  assert.equal(result.status, 3, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0])),
    [],
  );
  assert.match(result.stdout, /Cancelled\. Nothing was changed; the app was not stopped\./);
  // (The preamble before the question mentions uncertain outcomes itself.)
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /Restore done|Started the app again|docker start/,
  );
});

const promptSignals = [
  ["SIGINT", "INT"],
  ["SIGTERM", "TERM"],
  ["SIGHUP", "HUP"],
];
const promptRestore = "main restore daily.dump --project alpha";
// The stop prompt waits on a reader that never answers; the signal reaches
// this shell (the pipeline's subshell under `| cat`) while `read` blocks.
// Should the signal not cancel, the reader's EOF answers yes: the app is
// stopped and the test fails, so an ignored signal cannot pass as a decline.
// `before` runs first, in the background job that sends the signal.
const signalAtPrompt = (signal, before = "sleep 0.2") =>
  `require_terminal() { return 0; }
ask() { local answer pid=$BASHPID; ( ${before}; kill -${signal} "$pid" ) & read -r answer < <(exec 2>/dev/null; sleep 5) || true; return 0; }`;

test("host exits 3 and touches nothing on Ctrl-C (INT), TERM or HUP while the stop prompt waits", () => {
  for (const [name, signal] of promptSignals) {
    const result = run(`${signalAtPrompt(signal)}\n${promptRestore}`);
    assert.equal(result.status, 3, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    // Only discovery reached Docker: nothing was stopped, started or run.
    assert.deepEqual(
      result.calls
        .map((call) => call.args[0])
        .filter((verb) => !["ps", "inspect", "image", "info", "network"].includes(verb)),
      [],
      name,
    );
    assert.ok(
      result.stdout.endsWith("[app-db] Cancelled. Nothing was changed; the app was not stopped.\n"),
      `${name}: ${result.stdout}`,
    );
    assert.doesNotMatch(result.stderr, /\[app-db\]/, name);
  }
});

test("host keeps exit 3 for a signal at the stop prompt through `| tee` (pipefail / PIPESTATUS)", () => {
  for (const [name, signal] of promptSignals) {
    for (const [mode, tail] of [
      ["pipefail", `set -o pipefail\n${promptRestore} | cat\nexit $?`],
      ["PIPESTATUS", `set +o pipefail\n${promptRestore} | cat\nexit "\${PIPESTATUS[0]}"`],
    ]) {
      const result = run(`${signalAtPrompt(signal)}\n${tail}`);
      assert.equal(result.status, 3, `${name} (${mode}): ${result.stderr}`);
      assert.match(result.stdout, /Cancelled\. Nothing was changed; the app was not stopped\./);
      assert.ok(
        !result.calls.some((call) =>
          ["stop", "start", "run", "restart", "kill"].includes(call.args[0]),
        ),
        `${name} (${mode})`,
      );
    }
  }
});

test("host keeps exit 3 at the stop prompt when its `| tee` reader is already gone", () => {
  // The reader leaves after the last line before the prompt, as `tee` does
  // when Ctrl-C reaches it too; the cancel message then hits a broken pipe.
  const reader = `{ while IFS= read -r line; do case "$line" in *"asked once more"*) break ;; esac; done; }`;
  // Wait until the reader is gone: a write to the pipe fails only then (the
  // stray bytes go to a reader that no longer reads lines).
  const readerGone = `(trap '' PIPE; while printf x 2>/dev/null; do sleep 0.02; done)`;
  for (const [name, ask] of [
    ["declined", `ask() { ${readerGone}; return 1; }`],
    ...promptSignals.map(([name, signal]) => [name, signalAtPrompt(signal, readerGone)]),
  ]) {
    // Also with stderr in the same pipe (`2>&1 | tee`).
    for (const redirect of ["", "2>&1"]) {
      const result = run(`require_terminal() { return 0; }
${ask}
set +o pipefail
${promptRestore} ${redirect} | ${reader}
exit "\${PIPESTATUS[0]}"`);
      assert.equal(result.status, 3, `${name} ${redirect}: ${result.stderr}`);
      assert.ok(
        !result.calls.some((call) => ["stop", "start", "run"].includes(call.args[0])),
        `${name} ${redirect}`,
      );
    }
  }
});

test("host restores the previous signal traps right after the stop prompt", () => {
  const result = run(`ask() { return 0; }
trap 'echo previous-int' INT
trap - TERM
confirm_stop
trap -p INT TERM HUP`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "trap -- 'echo previous-int' SIGINT\n");
});

test("host keeps its own handling for a signal after the stop prompt (128+n, writers started again)", () => {
  for (const [name, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    const result = run(`require_terminal() { return 0; }\nask() { return 0; }\n${promptRestore}`, {
      stopSignal: name,
    });
    assert.equal(result.status, status, `${name}: ${result.signal ?? ""} ${result.stderr}`);
    assert.ok(!result.calls.some((call) => call.args[0] === "run"), name);
    const stopped = new Set(
      result.calls.filter((call) => call.args[0] === "stop").map((call) => call.args.at(-1)),
    );
    const started = result.calls
      .filter((call) => call.args[0] === "start")
      .map((call) => call.args.at(-1));
    assert.ok(started.length > 0, name);
    assert.deepEqual(new Set(started), stopped, name);
    assert.match(result.stderr, /Restore was not invoked; nothing was changed/, name);
    assert.doesNotMatch(result.stdout, /the app was not stopped/, name);
  }
});

test("host restarts every stopped writer when the restore is cancelled or refused (exit 3)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "3" },
  );
  assert.equal(result.status, 3, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    // The restart waits for each writer's stop (idempotent) before starting it.
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-app", "app-worker", "app-backup"],
  );
  assert.match(result.stderr, /Cancelled or refused; nothing was changed/);
  assert.doesNotMatch(result.stderr, /uncertain|Restore done/);
});

test("host restarts every stopped writer after a restore that rolled back (exit 4, database unchanged)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "4" },
  );
  assert.equal(result.status, 4, result.stderr);
  const actions = result.calls.filter((call) => ["stop", "start", "run"].includes(call.args[0]));
  assert.deepEqual(
    actions.map((call) => call.args[0]),
    ["stop", "stop", "stop", "run", "stop", "start", "stop", "start", "stop", "start"],
  );
  assert.deepEqual(
    actions.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-app", "app-worker", "app-backup"],
  );
  assert.match(
    result.stderr,
    /Restore failed and was rolled back; the database is unchanged[\s\S]*Started the app again/,
  );
  assert.doesNotMatch(result.stderr, /outcome is uncertain, or|Restore done|nothing was changed/);
});

test("host keeps writers stopped on docker run exit 125 (a wait failure can follow a started restore)", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
    { restoreExit: "125" },
  );
  assert.equal(result.status, 125, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start"),
    [],
  );
  assert.match(
    result.stderr,
    /Restore failed and its outcome is uncertain, or it committed and a later step failed \(exit 125\): the restore output above says which\. The app stays stopped/,
  );
});

test("host keeps writers stopped when restore is interrupted", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project alpha",
    { restoreSignal: "SIGTERM" },
  );
  assert.ok(result.signal === "SIGTERM" || result.status === 143);
  assert.ok(result.calls.some((call) => call.args.includes("--guided")));
  assert.ok(!result.calls.some((call) => call.args[0] === "start"));
  assert.match(
    result.stderr,
    /Restore failed and its outcome is uncertain, or it committed and a later step failed \(exit 143\): the restore output above says which\. The app stays stopped/,
  );
  assert.doesNotMatch(result.stdout + result.stderr, /Nothing was restored|database is as it was/);
});

test("host restore refuses before stopping anything when stdin is not a terminal", () => {
  // spawnSync gives the script a pipe for stdin: the real require_terminal.
  const result = run("ask() { return 0; }\nmain restore --project alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run it in a terminal/);
  assert.ok(!result.calls.some((call) => ["stop", "run", "start"].includes(call.args[0])));
});

test("host restore | tee: a terminal on stdin alone gets docker run -it", () => {
  // stdout is a pipe here (as with `| tee log`); stdin is reported as a terminal.
  const result = run(
    "stdin_is_terminal() { return 0; }\nrequire_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const restore = result.calls.find((call) => call.args[0] === "run");
  assert.ok(restore.args.includes("-it"), restore.args.join(" "));
});

test("host starts the app again when its stdout reader dies before the restore runs (`restore | tee`, Ctrl-C)", () => {
  // The reader leaves once the first writer is stopped, like `tee` killed by
  // Ctrl-C; every later write hits a broken pipe, so the restore never runs.
  const result = run(
    'require_terminal() { return 0; }\nask() { return 0; }\nmain restore daily.dump --project alpha | { while read -r _; do [ ! -f "$HOST_TEST_MARK" ] || break; done; }',
    { markOnStop: true },
  );
  assert.ok(!result.calls.some((call) => call.args[0] === "run"), result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-app", "app-worker", "app-backup"],
    result.stderr,
  );
});

test("host keeps the cancelled-restore restart when its stdout reader is gone (exit 3 under a dead pipe)", () => {
  const result = run(
    'require_terminal() { return 0; }\nask() { return 0; }\nsay() { :; }\nmain restore daily.dump --project alpha | { while read -r _; do [ ! -f "$HOST_TEST_MARK" ] || break; done; }',
    { markOnStop: true, restoreExit: "3" },
  );
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-app", "app-worker", "app-backup"],
    result.stderr,
  );
});

test("host supports S3-only backups without a backups volume", () => {
  const result = run("main backup --project alpha", { volume: "" });
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.args[0] === "run");
  assert.ok(!call.args.includes("-v"));
});

test("host restarts app writers even when stopping one fails", () => {
  const result = run(
    "require_terminal() { return 0; }\nask() { return 0; }\nmain restore --project alpha",
    { stopExit: "8", stopFailOn: "app-worker" },
  );
  assert.equal(result.status, 8, result.stderr);
  assert.deepEqual(
    result.calls.filter((call) => call.args[0] === "start").map((call) => call.args[1]),
    ["app-app", "app-worker", "app-backup"],
  );
  assert.ok(!result.calls.some((call) => call.args[0] === "run"));
});

test("host drill uses a throwaway private network and removes its database without an env file", () => {
  const result = run(
    "main drill s3://fake-backups/database/daily.dump --etag pinned --project alpha",
  );
  assert.equal(result.status, 0, result.stderr);
  const call = result.calls.find((item) => item.args.includes("restore-drill"));
  assert.match(call.args[call.args.indexOf("--network") + 1], /^wmp-drill-/);
  assert.deepEqual(call.args.slice(-4), [
    "restore-drill",
    "s3://fake-backups/database/daily.dump",
    "--etag",
    "pinned",
  ]);
  const assignment = call.env.split("\n").filter((line) => line.startsWith("DATABASE_URL="));
  assert.equal(assignment.length, 1);
  const target = new URL(assignment[0].slice("DATABASE_URL=".length));
  assert.equal(target.hostname, "drill-db");
  assert.equal(target.pathname, "/restore_drill");
  assert.doesNotMatch(call.env, /UNRELATED_SECRET/);
  assert.deepEqual(
    result.calls.slice(-2).map((item) => item.args.slice(0, 2)),
    [
      ["rm", "-f"],
      ["network", "rm"],
    ],
  );
  assert.deepEqual(result.files.sort(), ["calls.jsonl", "docker", "docker-stub.cjs"]);
  assert.doesNotMatch(result.stdout + result.stderr, /fake-secret|postgresql:/);
});

test("host stops with the recreate command when the app's image ID is gone, and never runs the tag", () => {
  for (const command of ["list", "backup", "drill", "restore daily.dump"]) {
    const result = run(
      `require_terminal() { return 0; }\nask() { return 0; }\nmain ${command} --project alpha`,
      { imageGone: true, workingDir: "/srv/wmp" },
    );
    assert.equal(result.status, 1, `${command}: ${result.stderr}`);
    assert.match(
      result.stderr,
      /the app container's image \(app-image\) is no longer on this machine/,
    );
    // The shipped compose's service `app`, with every compose file the deploy
    // used (the backups overlay too), from the container's own labels.
    assert.ok(
      result.stderr.includes(
        "cd /srv/wmp && docker compose -p alpha -f /srv/wmp/compose.yaml -f /srv/wmp/compose.backups.yaml up -d --no-build --force-recreate app\n",
      ),
      result.stderr,
    );
    assert.match(result.stderr, /add the same --env-file and --profile flags the deploy uses/);
    // Nothing was run, stopped or started: no fallback to the image's tag.
    assert.deepEqual(
      result.calls.filter((call) => ["run", "stop", "start"].includes(call.args[0])),
      [],
      command,
    );
    // It checked the container's image ID, not a tag.
    assert.ok(
      result.calls.some(
        (call) =>
          call.args[0] === "image" &&
          call.args[1] === "inspect" &&
          call.args.at(-1) === "app-image",
      ),
      command,
    );
  }
});

test("host's recreate command quotes a real compose directory and leaves the placeholder unquoted", () => {
  for (const [workingDir, expected] of [
    ["/etc/dokploy/compose/my app/code", "cd /etc/dokploy/compose/my\\ app/code && docker compose"],
    ["<no value>", "cd <the compose's directory> && docker compose"],
    ["", "cd <the compose's directory> && docker compose"],
  ]) {
    const result = run("main list --project alpha", { imageGone: true, workingDir });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(expected), `${JSON.stringify(workingDir)}: ${result.stderr}`);
  }
});

test("host's recreate command rebuilds the -f and --env-file lists from the app's compose labels", () => {
  for (const [labels, expected, note] of [
    [
      { configFiles: "/srv/my app/compose.yaml,/srv/my app/compose.backups.yaml" },
      "-p alpha -f /srv/my\\ app/compose.yaml -f /srv/my\\ app/compose.backups.yaml up -d",
      "--env-file and --profile flags",
    ],
    // No label (an older Compose): a placeholder, never a guessed file list.
    [
      { configFiles: "<no value>" },
      "-p alpha -f <each compose file the deploy uses> up -d",
      "--env-file and --profile flags",
    ],
    [
      { configFiles: "" },
      "-p alpha -f <each compose file the deploy uses> up -d",
      "--env-file and --profile flags",
    ],
    // compose.yaml requires its settings: the deploy's --env-file files, in order.
    [
      {
        configFiles: "/srv/wmp/compose.yaml,/srv/wmp/compose.backups.yaml",
        envFiles: "/etc/wmp/private.env,/etc/wmp/my extra.env",
      },
      "-p alpha --env-file /etc/wmp/private.env --env-file /etc/wmp/my\\ extra.env -f /srv/wmp/compose.yaml -f /srv/wmp/compose.backups.yaml up -d",
      "--profile flags",
    ],
  ]) {
    const result = run("main list --project alpha", { imageGone: true, ...labels });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(expected), `${JSON.stringify(labels)}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes(`(add the same ${note} the deploy uses, if any)`),
      `${JSON.stringify(labels)}: ${result.stderr}`,
    );
  }
});

test("host finds the app only as the compose service `app` (compose.yaml), never another name", () => {
  const result = run("main list");
  assert.equal(result.status, 0, result.stderr);
  const filters = result.calls
    .filter((call) => call.args[0] === "ps")
    .flatMap((call) =>
      call.args.filter((arg) => arg.startsWith("label=com.docker.compose.service=")),
    );
  assert.deepEqual(filters, [
    "label=com.docker.compose.service=app",
    "label=com.docker.compose.service=app",
    "label=com.docker.compose.service=postgres",
  ]);
  assert.match(result.stdout, /app "alpha": app container app-app/);
  const runCall = result.calls.find((call) => call.args[0] === "run");
  assert.deepEqual(runCall.args.slice(-2), ["restore", "--list"]);
});
