import assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  dailyPrunePlan,
  dueAtStart,
  dumpDay,
  healthFromFile,
  healthFromStatus,
  healthOf,
  migrationGate,
  nextAction,
  nextRunAt,
  recoveredLastSuccess,
  STATUS_FILE,
  scheduleConfig,
  writeStatus,
} from "./schedule.mjs";

const HOUR = 3_600_000;

describe("scheduleConfig", () => {
  it("is off unless BACKUP_SCHEDULE=daily", () => {
    assert.deepEqual(scheduleConfig({}), { enabled: false });
    assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "off" }), { enabled: false });
    assert.deepEqual(scheduleConfig({ BACKUP_SCHEDULE: "daily" }), {
      enabled: true,
      hourUtc: 3,
      keep: 14,
    });
    assert.deepEqual(
      scheduleConfig({ BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "0", BACKUP_KEEP: "30" }),
      { enabled: true, hourUtc: 0, keep: 30 },
    );
  });
  it("rejects values it would otherwise guess at", () => {
    for (const env of [
      { BACKUP_SCHEDULE: "hourly" },
      { BACKUP_SCHEDULE: "true" },
      { BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "24" },
      { BACKUP_SCHEDULE: "daily", BACKUP_HOUR_UTC: "3.5" },
      { BACKUP_SCHEDULE: "daily", BACKUP_KEEP: "0" },
    ])
      assert.throws(() => scheduleConfig(env), /BACKUP_/, JSON.stringify(env));
  });
});

describe("timing", () => {
  it("runs next at the configured UTC hour, today or tomorrow", () => {
    const now = Date.UTC(2026, 10, 11, 2, 30);
    assert.equal(nextRunAt(now, 3), Date.UTC(2026, 10, 11, 3));
    assert.equal(nextRunAt(now, 2), Date.UTC(2026, 10, 12, 2));
    assert.equal(nextRunAt(Date.UTC(2026, 11, 31, 23), 3), Date.UTC(2027, 0, 1, 3));
    // Exactly on the hour: the run that just happened is not repeated.
    assert.equal(nextRunAt(Date.UTC(2026, 10, 11, 3), 3), Date.UTC(2026, 10, 12, 3));
  });
  it("backs up at start when there is no success or the last scheduled run was missed", () => {
    const now = Date.UTC(2026, 10, 11, 12);
    assert.equal(dueAtStart(null, now, 3), true);
    assert.equal(dueAtStart(now - 25 * HOUR, now, 3), true);
    assert.equal(dueAtStart(now - 2 * HOUR, now, 3), false);
    // Today's 03:00 run already succeeded (03:10): not due.
    assert.equal(dueAtStart(Date.UTC(2026, 10, 11, 3, 10), now, 3), false);
    // Restart at 03:05 after yesterday's 03:10 success: today's run is missed → due
    // (under 24 h old, but older than today's scheduled time).
    const restart = Date.UTC(2026, 10, 11, 3, 5);
    assert.equal(dueAtStart(Date.UTC(2026, 10, 10, 3, 10), restart, 3), true);
    // Restart at 02:00, before today's slot, after yesterday's run: wait for 03:00.
    assert.equal(dueAtStart(Date.UTC(2026, 10, 10, 3, 10), Date.UTC(2026, 10, 11, 2), 3), false);
  });
});

describe("healthOf", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const base = { enabled: true, startedAt: now - 2 * HOUR, lastSuccess: null, lastFailure: null };
  it("is healthy when off, or after a recent success", () => {
    assert.equal(healthOf({ ...base, enabled: false }, now).healthy, true);
    assert.equal(
      healthOf(
        { ...base, enabled: false, lastSuccess: now - 48 * HOUR, lastFailure: now - HOUR },
        now,
      ).healthy,
      true,
    );
    assert.equal(healthOf({ ...base, lastSuccess: now - HOUR }, now).healthy, true);
    assert.equal(healthOf({ ...base, startedAt: now - 60_000 }, now).healthy, true);
  });
  it("is unhealthy after a failure, a stale success, or no success at all", () => {
    assert.equal(healthOf({ ...base, lastFailure: now - HOUR }, now).healthy, false);
    assert.equal(
      healthOf({ ...base, lastSuccess: now - 3 * HOUR, lastFailure: now - HOUR }, now).healthy,
      false,
    );
    assert.equal(
      healthOf({ ...base, lastSuccess: now - HOUR, lastFailure: now - 3 * HOUR }, now).healthy,
      true,
    );
    assert.equal(healthOf({ ...base, lastSuccess: now - 27 * HOUR }, now).healthy, false);
    assert.equal(healthOf(base, now).healthy, false);
  });
});

describe("healthFromStatus (the healthcheck)", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const daily = { BACKUP_SCHEDULE: "daily" };
  const status = (fields) =>
    JSON.stringify({
      enabled: true,
      startedAt: now - 2 * HOUR,
      lastSuccess: now - HOUR,
      lastFailure: null,
      ...fields,
    });
  it("is healthy when off, whatever the status file says", () => {
    for (const text of [null, "", "{", status({ lastFailure: now })])
      assert.equal(healthFromStatus(text, {}, now).healthy, true);
  });
  it("with daily backups, a missing, partial or malformed status file is unhealthy", () => {
    for (const text of [
      null,
      "",
      '{"enabled":true,"startedAt":',
      "null",
      "[]",
      status({ enabled: false }),
      status({ startedAt: "yesterday" }),
      status({ lastSuccess: "today" }),
      status({ lastFailure: undefined }),
    ])
      assert.equal(healthFromStatus(text, daily, now).healthy, false, String(text));
    assert.match(healthFromStatus(null, daily, now).reason, /no backup status/);
  });
  it("with daily backups, a valid status file gets healthOf's verdict", () => {
    assert.deepEqual(healthFromStatus(status({}), daily, now), {
      healthy: true,
      reason: "last backup succeeded",
    });
    assert.equal(healthFromStatus(status({ lastFailure: now }), daily, now).healthy, false);
    assert.equal(
      healthFromStatus(status({ lastSuccess: now - 27 * HOUR }), daily, now).healthy,
      false,
    );
  });
  it("invalid schedule settings are unhealthy", () => {
    const verdict = healthFromStatus(status({}), { BACKUP_SCHEDULE: "hourly" }, now);
    assert.equal(verdict.healthy, false);
    assert.match(verdict.reason, /BACKUP_SCHEDULE/);
  });
});

describe("the status file (writeStatus + healthFromFile)", () => {
  const now = Date.UTC(2026, 10, 11, 12);
  const daily = { BACKUP_SCHEDULE: "daily" };
  const dir = mkdtempSync(path.join(tmpdir(), "schedule-status-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const fresh = () => path.join(dir, `status-${++n}.json`);
  const ok = {
    enabled: true,
    startedAt: now - 2 * HOUR,
    lastSuccess: now - HOUR,
    lastFailure: null,
  };

  it("defaults to the fixed path in /tmp", () => {
    assert.equal(STATUS_FILE, "/tmp/wmp-backup-status.json");
  });
  it("reads the status the loop wrote", () => {
    const file = fresh();
    writeStatus(ok, file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), ok);
    assert.deepEqual(healthFromFile(daily, now, file), {
      healthy: true,
      reason: "last backup succeeded",
    });
    writeStatus({ ...ok, lastFailure: now }, file);
    assert.equal(healthFromFile(daily, now, file).healthy, false);
  });
  it("a missing status file is unhealthy with daily backups, and names the file", () => {
    const file = fresh();
    const verdict = healthFromFile(daily, now, file);
    assert.equal(verdict.healthy, false);
    assert.match(verdict.reason, /no backup status/);
    assert.ok(verdict.reason.includes(file), verdict.reason);
    assert.equal(healthFromFile({}, now, file).healthy, true);
  });
  it("an unreadable status file (a directory) is unhealthy with daily backups", () => {
    const file = fresh();
    mkdirSync(file);
    assert.match(healthFromFile(daily, now, file).reason, /no backup status/);
  });
  it("replaces the file by rename (a reader never sees a half-written one) and leaves no partial", () => {
    const file = fresh();
    writeStatus(ok, file);
    // A hard link keeps the old inode: an in-place write would change it too.
    const old = `${file}.old-link`;
    linkSync(file, old);
    const next = { ...ok, lastSuccess: now };
    writeStatus(next, file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
    assert.deepEqual(JSON.parse(readFileSync(old, "utf8")), ok);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
  it("writes only to a partial file, then renames it over the status file", () => {
    const file = fresh();
    writeStatus(ok, file);
    /** @type {string[][]} */
    const calls = [];
    const io = {
      writeFileSync: (/** @type {string} */ target, /** @type {string} */ data) => {
        calls.push(["write", target]);
        writeFileSync(target, data);
      },
      renameSync: (/** @type {string} */ from, /** @type {string} */ to) => {
        calls.push(["rename", from, to]);
        renameSync(from, to);
      },
      unlinkSync: (/** @type {string} */ target) => {
        calls.push(["unlink", target]);
        unlinkSync(target);
      },
    };
    writeStatus({ ...ok, lastSuccess: now }, file, io);
    const partial = `${file}.${process.pid}.tmp`;
    assert.deepEqual(calls, [
      ["write", partial],
      ["rename", partial, file],
    ]);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).lastSuccess, now);
  });
  it("a failed write warns, leaves the target alone and removes its partial", (t) => {
    const file = fresh();
    // The target is a non-empty directory, so the rename fails after the write.
    mkdirSync(file);
    writeFileSync(path.join(file, "x"), "");
    const log = t.mock.method(console, "log", () => {});
    writeStatus(ok, file);
    assert.match(String(log.mock.calls.at(-1)?.arguments[0]), /WARNING: could not write/);
    assert.deepEqual(readdirSync(file), ["x"]);
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });
});

describe("retention: one dump per UTC day", () => {
  it("keeps the newest dump of each of the newest N days, whatever the retries", () => {
    const names = [
      "daily-20261108T030000Z.dump",
      "daily-20261109T030000Z.dump",
      "daily-20261110T030000Z.dump",
      // Hourly retries on the 11th (upload failing): only the newest stays.
      "daily-20261111T030000Z.dump",
      "daily-20261111T040000Z.dump",
      "daily-20261111T050000Z.dump",
      "daily-20261111T050000Z-77.dump",
      "manual-20261101T000000Z.dump",
      "pre-migrate-20261101T000000Z.dump",
      ".daily-20261111T060000Z.dump.partial",
    ];
    assert.deepEqual(dailyPrunePlan(names, 3), [
      "daily-20261108T030000Z.dump",
      "daily-20261111T030000Z.dump",
      "daily-20261111T040000Z.dump",
      "daily-20261111T050000Z.dump",
    ]);
    // Twelve failed retries never push the older days out of a 14-day window.
    const retries = Array.from(
      { length: 12 },
      (_, hour) => `daily-20261111T${String(hour + 3).padStart(2, "0")}0000Z.dump`,
    );
    const history = ["daily-20261109T030000Z.dump", "daily-20261110T030000Z.dump"];
    const kept = [...history, ...retries].filter(
      (name) => !dailyPrunePlan([...history, ...retries], 14).includes(name),
    );
    assert.deepEqual(kept, [...history, "daily-20261111T140000Z.dump"]);
    assert.deepEqual(dailyPrunePlan([], 14), []);
    assert.equal(dumpDay("daily-20261111T030000Z.dump"), "20261111");
    assert.equal(dumpDay("manual-20261111T030000Z.dump"), null);
  });
});

describe("retries and restarts", () => {
  const now = Date.UTC(2026, 10, 11, 9);
  it("re-uploads today's dump instead of dumping again; a new day dumps afresh", () => {
    assert.equal(nextAction("daily-20261111T030000Z.dump", now), "upload");
    assert.equal(nextAction("daily-20261110T030000Z.dump", now), "dump");
    assert.equal(nextAction(null, now), "dump");
  });
  it("recovers the remembered success; a bare local dump counts only without uploads", () => {
    assert.equal(recoveredLastSuccess({ lastSuccess: now - HOUR }, now, true), now - HOUR);
    assert.equal(recoveredLastSuccess({ lastSuccess: null }, now, true), null);
    assert.equal(recoveredLastSuccess(null, now - HOUR, true), null);
    assert.equal(recoveredLastSuccess(null, now - HOUR, false), now - HOUR);
    assert.equal(recoveredLastSuccess(null, null, false), null);
  });
});

describe("migrationGate", () => {
  const idle = { runnerHeld: false, prismaHeld: false, hasHistory: true, unfinished: 0 };
  it("dumps only when no migration runs and none is unfinished", () => {
    assert.equal(migrationGate(idle), "ready");
    // The first migration creates _prisma_migrations early, under the runner lock.
    assert.equal(migrationGate({ ...idle, runnerHeld: true, unfinished: 1 }), "busy");
    assert.equal(migrationGate({ ...idle, prismaHeld: true }), "busy");
    assert.equal(migrationGate({ ...idle, unfinished: 1 }), "failed");
    assert.equal(migrationGate({ ...idle, hasHistory: false }), "new-install");
  });
});
