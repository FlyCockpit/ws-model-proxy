import assert from "node:assert/strict";

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Stop a spawned e2e child (and its process group) and wait for it to be gone.
 * A child that was already killed by a signal has `exitCode === null` but a
 * `signalCode`, and never emits `exit` again: treating only `exitCode` as "done"
 * hangs forever on it (#159, #172).
 */
export async function waitForExit(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (name) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const exited = new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) resolveExit();
    else child.once("exit", resolveExit);
  });
  signal("SIGCONT");
  signal("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
  if (!graceful) {
    signal("SIGKILL");
    await exited;
  }
  assert(child.signalCode || child.exitCode !== null, `${label} did not exit`);
}
