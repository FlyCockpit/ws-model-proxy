import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com" },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));
vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
const fence = vi.hoisted(() => ({ armed: false }));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({
  isDbShutdownFenceArmed: () => fence.armed,
}));
const mail = vi.hoisted(() => ({
  configured: true,
  sendEmail: vi.fn(async (_message: { to: string; subject: string; html: string }) => {}),
}));
vi.mock("@ws-model-proxy/mailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ws-model-proxy/mailer")>()),
  isEmailConfigured: () => mail.configured,
  sendEmail: mail.sendEmail,
}));

import prisma from "@ws-model-proxy/db";
import {
  NEEDS_YOU_MAIL_MAX_FAILURES,
  NEEDS_YOU_MAIL_PER_WINDOW,
  NEEDS_YOU_MAIL_WINDOW_MS,
  needsYouActionUrl,
  notifyQueuedCommand,
  resetNeedsYouMailLimiter,
  sweepNeedsYouMail,
} from "./needs-you-mail";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const now = new Date("2026-10-08T12:00:00Z");
const since = new Date("2026-10-08T11:59:00Z");

function need(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst1",
    userId: "owner",
    runtimeId: "rt1",
    needsOperator: "RESTART",
    needsOperatorSince: since,
    needsOperatorNotifiedAt: null,
    needsOperatorNotifyFailures: 0,
    Runtime: { name: "qwen-32b", User: { email: "o@example.test", locale: "es-MX" } },
    ...overrides,
  };
}

beforeEach(() => {
  mockReset(db);
  mail.configured = true;
  fence.armed = false;
  mail.sendEmail.mockReset();
  mail.sendEmail.mockResolvedValue(undefined);
  resetNeedsYouMailLimiter();
  db.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
});

describe("sweepNeedsYouMail", () => {
  it("mails the owner once per new need, linking to where it is resolved", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([
      need(),
      need({ id: "inst2", needsOperator: "STEP", Runtime: need().Runtime }),
      need({ id: "inst3", needsOperator: "MARK_STOPPED" }),
    ] as never);
    await expect(sweepNeedsYouMail(now)).resolves.toBe(3);
    const [restart, step, markStopped] = mail.sendEmail.mock.calls.map((call) => call[0]);
    expect(restart).toMatchObject({
      to: "o@example.test",
      subject: "qwen-32b necesita reiniciarse",
    });
    expect(restart?.html).toContain("https://proxy.example.com/es-MX/runtimes/rt1");
    expect(step?.html).toContain("https://proxy.example.com/es-MX/terminals");
    expect(markStopped?.html).toContain("https://proxy.example.com/es-MX/runtimes/rt1");
    // The candidates: new needs only (unmarked, or marked before the need began), of owners with
    // alerts on and a proved mailbox, recent enough.
    const where = db.runtimeInstance.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      needsOperator: { not: null },
      Runtime: { User: { operationalAlerts: true, emailVerified: true } },
    });
    // Unmarked, or marked for an earlier need: the column is compared with needsOperatorSince.
    expect(where?.OR).toEqual([
      { needsOperatorNotifiedAt: null },
      { needsOperatorNotifiedAt: { lt: db.runtimeInstance.fields.needsOperatorSince } },
    ]);
    // Each one is claimed with a compare-and-set on the need as read, before it is sent.
    expect(db.runtimeInstance.updateMany.mock.calls[0]?.[0]).toEqual({
      where: {
        id: "inst1",
        needsOperator: "RESTART",
        needsOperatorSince: since,
        needsOperatorNotifiedAt: null,
      },
      // The marker is the need's own start, not a clock reading.
      data: { needsOperatorNotifiedAt: since },
    });
  });

  it("mails a need raised again after one already mailed", async () => {
    const earlier = new Date(since.getTime() - 600_000);
    db.runtimeInstance.findMany.mockResolvedValue([
      need({ needsOperatorNotifiedAt: earlier }),
    ] as never);
    await expect(sweepNeedsYouMail(now)).resolves.toBe(1);
    expect(db.runtimeInstance.updateMany.mock.calls[0]?.[0]?.where).toMatchObject({
      needsOperatorNotifiedAt: earlier,
    });
  });

  it("stops claiming once the shutdown fence is armed", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([need()] as never);
    fence.armed = true;
    await expect(sweepNeedsYouMail(now)).resolves.toBe(0);
    expect(db.runtimeInstance.updateMany).not.toHaveBeenCalled();
  });

  it("sends nothing and reads nothing without SMTP", async () => {
    mail.configured = false;
    await expect(sweepNeedsYouMail(now)).resolves.toBe(0);
    expect(db.runtimeInstance.findMany).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("never sends a need twice: a lost claim sends nothing", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([need()] as never);
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 0 });
    await expect(sweepNeedsYouMail(now)).resolves.toBe(0);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("releases the claim after a failed send, and gives up after the last try", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([need()] as never);
    mail.sendEmail.mockRejectedValue(new Error("smtp down"));
    await expect(sweepNeedsYouMail(now)).resolves.toBe(0);
    const released = new Date(since.getTime() - 1);
    expect(db.runtimeInstance.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "inst1", needsOperatorSince: since, needsOperatorNotifiedAt: since },
      data: { needsOperatorNotifiedAt: released, needsOperatorNotifyFailures: 1 },
    });
    db.runtimeInstance.updateMany.mockClear();
    db.runtimeInstance.findMany.mockResolvedValue([
      need({
        needsOperatorNotifiedAt: released,
        needsOperatorNotifyFailures: NEEDS_YOU_MAIL_MAX_FAILURES - 1,
      }),
    ] as never);
    await sweepNeedsYouMail(now);
    expect(db.runtimeInstance.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "inst1", needsOperatorSince: since, needsOperatorNotifiedAt: since },
      data: { needsOperatorNotifyFailures: 0 },
    });
  });

  it("does not count an earlier need's failures against a new one", async () => {
    mail.sendEmail.mockRejectedValue(new Error("smtp down"));
    db.runtimeInstance.findMany.mockResolvedValue([
      // Failed for a need released at an older marker; this need started later.
      need({
        needsOperatorNotifiedAt: new Date(since.getTime() - 600_001),
        needsOperatorNotifyFailures: NEEDS_YOU_MAIL_MAX_FAILURES - 1,
      }),
    ] as never);
    await sweepNeedsYouMail(now);
    expect(db.runtimeInstance.updateMany.mock.calls[1]?.[0]?.data).toEqual({
      needsOperatorNotifiedAt: new Date(since.getTime() - 1),
      needsOperatorNotifyFailures: 1,
    });
  });

  it("resets the failure count after a successful retry", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([
      need({
        needsOperatorNotifiedAt: new Date(since.getTime() - 1),
        needsOperatorNotifyFailures: 2,
      }),
    ] as never);
    await expect(sweepNeedsYouMail(now)).resolves.toBe(1);
    expect(db.runtimeInstance.updateMany.mock.calls[1]?.[0]).toEqual({
      where: { id: "inst1", needsOperatorSince: since, needsOperatorNotifiedAt: since },
      data: { needsOperatorNotifyFailures: 0 },
    });
  });

  it("rate-limits per user, and leaves the rest for a later sweep", async () => {
    const many = Array.from({ length: NEEDS_YOU_MAIL_PER_WINDOW + 2 }, (_, i) =>
      need({ id: `inst${i}` }),
    );
    db.runtimeInstance.findMany.mockResolvedValue([
      ...many,
      need({ id: "other", userId: "someone" }),
    ] as never);
    await expect(sweepNeedsYouMail(now)).resolves.toBe(NEEDS_YOU_MAIL_PER_WINDOW + 1);
    // Unclaimed: only the sent ones were marked.
    expect(db.runtimeInstance.updateMany).toHaveBeenCalledTimes(NEEDS_YOU_MAIL_PER_WINDOW + 1);
    // The next sweep skips the limited owner in the query itself (no starvation of others).
    db.runtimeInstance.findMany.mockResolvedValue([] as never);
    await sweepNeedsYouMail(new Date(now.getTime() + 60_000));
    expect(db.runtimeInstance.findMany.mock.calls[1]?.[0]?.where?.userId).toEqual({
      notIn: ["owner"],
    });
    // A window later the owner can be mailed again.
    db.runtimeInstance.findMany.mockResolvedValue([need({ id: "late" })] as never);
    await expect(
      sweepNeedsYouMail(new Date(now.getTime() + NEEDS_YOU_MAIL_WINDOW_MS + 1)),
    ).resolves.toBe(1);
  });
});

describe("notifyQueuedCommand", () => {
  it("mails the owner that a command waits in Terminals", async () => {
    db.user.findFirst.mockResolvedValue({ email: "o@example.test", locale: "en-US" } as never);
    await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "gpu-box", now })).resolves.toBe(
      true,
    );
    expect(db.user.findFirst.mock.calls[0]?.[0]?.where).toMatchObject({
      id: "owner",
      operationalAlerts: true,
      emailVerified: true,
    });
    expect(mail.sendEmail.mock.calls[0]?.[0]).toMatchObject({
      to: "o@example.test",
      subject: "An agent queued a command for you on gpu-box",
    });
    expect(mail.sendEmail.mock.calls[0]?.[0].html).toContain(
      "https://proxy.example.com/en-US/terminals",
    );
  });

  it("sends nothing without SMTP", async () => {
    mail.configured = false;
    await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "box" })).resolves.toBe(false);
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("gives the rate-limit slot back when the send fails", async () => {
    db.user.findFirst.mockResolvedValue({ email: "o@example.test", locale: "en-US" } as never);
    mail.sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "box", now })).resolves.toBe(
      false,
    );
    for (let i = 0; i < NEEDS_YOU_MAIL_PER_WINDOW; i += 1) {
      await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "box", now })).resolves.toBe(
        true,
      );
    }
  });

  it("sends nothing when the owner turned alerts off", async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "box" })).resolves.toBe(false);
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("shares the per-user limit and never throws", async () => {
    db.user.findFirst.mockResolvedValue({ email: "o@example.test", locale: "en-US" } as never);
    for (let i = 0; i < NEEDS_YOU_MAIL_PER_WINDOW; i += 1) {
      await notifyQueuedCommand({ userId: "owner", nodeSlug: "box", now });
    }
    await expect(notifyQueuedCommand({ userId: "owner", nodeSlug: "box", now })).resolves.toBe(
      false,
    );
    expect(mail.sendEmail).toHaveBeenCalledTimes(NEEDS_YOU_MAIL_PER_WINDOW);
    db.user.findFirst.mockRejectedValue(new Error("db down"));
    await expect(notifyQueuedCommand({ userId: "other", nodeSlug: "box", now })).resolves.toBe(
      false,
    );
  });
});

describe("needsYouActionUrl", () => {
  it("falls back to the default locale and escapes the runtime id", () => {
    expect(needsYouActionUrl("restart", "fr-FR", "a/b")).toBe(
      "https://proxy.example.com/en-US/runtimes/a%2Fb",
    );
  });
});
