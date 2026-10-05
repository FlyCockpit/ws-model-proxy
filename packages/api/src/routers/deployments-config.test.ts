import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildContext, db as forwarderDb } from "./forwarder-test-helpers";

const { deploymentsRouter } = await import("./deployments");

type Mocked = Record<string, Record<string, ReturnType<typeof vi.fn>>> & {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};
const db = forwarderDb as unknown as Mocked;
const spec = {
  variants: [
    {
      key: "one",
      groupSize: 1,
      resources: [{ kind: "unified", memoryGb: 10 }],
      commands: [{ management: "ownedProcess", start: "serve", stop: "stop" }],
      readiness: {},
      models: ["model"],
      attachment: { type: "llm", poolId: "pool" },
      hardConcurrencyLimit: 1,
    },
  ],
};
const client = () => createRouterClient(deploymentsRouter, { context: buildContext() });
const update = (slug?: string) =>
  client().updateConfig({
    id: "config",
    expectedRevision: 1,
    ...(slug !== undefined ? { slug } : {}),
    spec: spec as never,
  });

beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(db));
  // Owner lock and the recipe row lock.
  db.$queryRaw.mockResolvedValue([{ id: "config" }]);
  db.deploymentConfig.findUniqueOrThrow.mockResolvedValue({
    id: "config",
    userId: "user-id",
    poolId: "pool",
    slug: "qwen-",
    Revisions: [{ revision: 1 }],
  });
  db.deploymentConfig.findFirst.mockResolvedValue(null);
  db.deploymentInstance.count.mockResolvedValue(0);
  db.deploymentConfigRevision.create.mockResolvedValue({ revision: 2 });
});

describe("renaming a recipe", () => {
  it("renames a stopped recipe, fixing a slug saved before the slug rule", async () => {
    await update("qwen");
    expect(db.deploymentConfig.update).toHaveBeenCalledWith({
      where: { id: "config" },
      data: { slug: "qwen" },
    });
  });

  it("leaves the slug alone when it is omitted or unchanged", async () => {
    await update();
    await update("qwen-x");
    expect(db.deploymentConfig.update).toHaveBeenCalledTimes(1);
    db.deploymentConfig.update.mockClear();
    db.deploymentConfig.findUniqueOrThrow.mockResolvedValue({
      id: "config",
      userId: "user-id",
      poolId: "pool",
      slug: "qwen-x",
      Revisions: [{ revision: 1 }],
    });
    await update("qwen-x");
    expect(db.deploymentConfig.update).not.toHaveBeenCalled();
  });

  it("refuses while a deployment runs, and a slug another recipe uses", async () => {
    db.deploymentInstance.count.mockResolvedValue(1);
    await expect(update("qwen")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "deployments_running" },
    });
    db.deploymentInstance.count.mockResolvedValue(0);
    db.deploymentConfig.findFirst.mockResolvedValue({ id: "other" });
    await expect(update("qwen")).rejects.toMatchObject({
      code: "CONFLICT",
      data: { reason: "slug_taken" },
    });
    expect(db.deploymentConfig.update).not.toHaveBeenCalled();
    expect(db.deploymentConfigRevision.create).not.toHaveBeenCalled();
  });

  it("takes only slugs nodes accept", async () => {
    for (const slug of ["qwen-", "qw--en", "Qwen"])
      await expect(update(slug)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
