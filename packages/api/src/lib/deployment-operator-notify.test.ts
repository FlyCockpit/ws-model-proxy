import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({ env: { BETTER_AUTH_URL: "https://app.example" } }));
vi.mock("@ws-model-proxy/env/shared", () => ({ env: {} }));

import {
  DEPLOYMENT_NEED_EMAIL_DELAY_MS,
  notifyDeploymentOperatorNeeds,
} from "./deployment-operator-notify";

const now = new Date("2026-10-05T12:00:00Z");
function fakeDb(rows: unknown[], claimed = 1) {
  return {
    deploymentInstance: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: claimed }),
    },
  };
}
const row = {
  id: "instance",
  endpointSlug: "inst-qwen",
  needsOperator: "STEP",
  needsOperatorSince: new Date(now.getTime() - 10 * 60_000),
  User: { email: "owner@example.com", locale: "es-MX" },
};

describe("needs-you email notices", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing, not even a query, without SMTP", async () => {
    const db = fakeDb([row]);
    const send = vi.fn();
    expect(
      await notifyDeploymentOperatorNeeds({ db: db as never, now, send, configured: false }),
    ).toBe(0);
    expect(db.deploymentInstance.findMany).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("claims each settled need once, then emails the owner in their locale", async () => {
    const db = fakeDb([row]);
    const send = vi.fn().mockResolvedValue(undefined);
    expect(
      await notifyDeploymentOperatorNeeds({ db: db as never, now, send, configured: true }),
    ).toBe(1);
    const query = db.deploymentInstance.findMany.mock.calls[0]?.[0];
    expect(query.where.needsOperatorSince).toEqual({
      lte: new Date(now.getTime() - DEPLOYMENT_NEED_EMAIL_DELAY_MS),
    });
    expect(query.where.User).toMatchObject({ emailVerified: true, deletionRequestedAt: null });
    expect(db.deploymentInstance.updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { id: "instance", needsOperator: "STEP", needsOperatorSince: row.needsOperatorSince },
      data: { needsOperatorNotifiedAt: now },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "owner@example.com", subject: "Un despliegue te necesita" }),
    );
    expect(send.mock.calls[0]?.[0].html).toContain(
      "https://app.example/es-MX/dashboard/deployments",
    );
  });

  it("skips a notice another replica claimed, and survives a failed send", async () => {
    const claimedElsewhere = fakeDb([row], 0);
    const send = vi.fn().mockRejectedValue(new Error("smtp down"));
    expect(
      await notifyDeploymentOperatorNeeds({
        db: claimedElsewhere as never,
        now,
        send,
        configured: true,
      }),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await notifyDeploymentOperatorNeeds({
        db: fakeDb([row]) as never,
        now,
        send,
        configured: true,
      }),
    ).toBe(0);
    expect(warn).toHaveBeenCalledWith("[deployments] needs-you email failed: Error");
    warn.mockRestore();
  });
});
