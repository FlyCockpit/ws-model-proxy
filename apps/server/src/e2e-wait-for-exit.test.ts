import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

/**
 * The e2e scripts' shared `waitForExit` (scripts/lib/wait-for-exit.mjs): a child
 * that a signal already killed has `exitCode === null` and a `signalCode`, and never
 * emits `exit` again, so waiting on `exitCode` alone hung forever (#159, #172).
 */
const helper: { waitForExit: (child: ChildProcess, label: string) => Promise<void> } = await import(
  new URL("../../../scripts/lib/wait-for-exit.mjs", import.meta.url).href
);

const idleChild = () =>
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });

const within = async (ms: number, work: Promise<void>): Promise<"done" | "hung"> =>
  Promise.race([
    work.then(() => "done" as const),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);

describe.skipIf(process.platform === "win32")("e2e waitForExit", () => {
  it("returns at once for a child a signal already killed", async () => {
    const child = idleChild();
    await once(child, "spawn");
    child.kill("SIGKILL");
    await once(child, "exit");
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe("SIGKILL");
    expect(await within(1_500, helper.waitForExit(child, "killed"))).toBe("done");
  });

  it("returns at once for a child that already exited normally", async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
    expect(await within(1_500, helper.waitForExit(child, "exited"))).toBe("done");
  });

  it("stops a live child with SIGTERM and waits for it", async () => {
    const child = idleChild();
    await once(child, "spawn");
    expect(await within(2_500, helper.waitForExit(child, "live"))).toBe("done");
    expect(child.signalCode === "SIGTERM" || child.exitCode !== null).toBe(true);
  });
});
