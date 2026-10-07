import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Target recovery on real PostgreSQL: the due-target query reads the models' EFFECTIVE
// capabilities (once it read only the owner-override column, empty for nearly every model,
// so a degraded member of an always-on runtime was never probed and never recovered), and a
// successful probe makes the target healthy again.

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required for PostgreSQL integration tests");
const integration = databaseUrl ? describe : describe.skip;

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

integration("target recovery (PostgreSQL)", () => {
  type Fixture = ReturnType<
    typeof import("@ws-model-proxy/db/test-fixture-client")["createFixturePrismaClient"]
  >;
  let fixture: Fixture;
  let recovery: typeof import("./target-recovery.js");
  let prisma: typeof import("@ws-model-proxy/db")["default"];
  const suffix = randomUUID().slice(0, 8);
  const userId = `tr-${suffix}`;
  const nodeId = `trnode${suffix}`;
  const targets: Record<"chat" | "declared" | "override" | "embeddings" | "transcription", string> =
    {
      chat: "",
      declared: "",
      override: "",
      embeddings: "",
      transcription: "",
    };

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const { createFixturePrismaClient } = await import("@ws-model-proxy/db/test-fixture-client");
    fixture = createFixturePrismaClient(databaseUrl ?? "");
    recovery = await import("./target-recovery.js");
    prisma = (await import("@ws-model-proxy/db")).default;
    await fixture.user.create({
      data: { id: userId, name: "Recovery", email: `${userId}@example.test` },
    });
    await fixture.node.create({
      data: {
        id: nodeId,
        userId,
        slug: `tr-${suffix}`,
        connection: "ONLINE",
        connectionGeneration: 1,
        trust: "FULL",
      },
    });
    // An always-on wrap per model type (the shape always-on.ts writes).
    const models = [
      { key: "chat", type: "LLM", detected: ["TEXT_GENERATION"], override: null },
      // Listed in the spec without capabilities: none stored.
      { key: "declared", type: "LLM", detected: [], override: null },
      { key: "override", type: "LLM", detected: [], override: ["TEXT_GENERATION"] },
      { key: "embeddings", type: "EMBEDDINGS", detected: ["EMBEDDING"], override: null },
      { key: "transcription", type: "TRANSCRIPTION", detected: ["AUDIO_INPUT"], override: null },
    ] as const;
    for (const model of models) {
      const slug = `tr-${model.key}-${suffix}`;
      const runtime = await fixture.runtime.create({
        data: { userId, slug, name: slug, kind: "ALWAYS_ON", origin: "SERVER", nodeId },
      });
      const version = await fixture.runtimeVersion.create({
        data: {
          runtimeId: runtime.id,
          version: 1,
          editor: "USER",
          editorUserId: userId,
          contentHash: hex(`content-${slug}`),
          launchHash: hex(`launch-${slug}`),
          spec: {
            api: "openai",
            engine: "vllm",
            modelType: model.type.toLowerCase(),
            models: [{ id: "m" }],
            address: { baseUrl: "http://127.0.0.1:8000" },
          },
          api: "OPENAI",
          engine: "VLLM",
          modelType: model.type,
        },
      });
      await fixture.runtime.update({
        where: { id: runtime.id },
        data: { currentVersionId: version.id },
      });
      const runtimeModel = await fixture.runtimeModel.create({
        data: {
          userId,
          runtimeId: runtime.id,
          upstreamModelId: `m-${model.key}`,
          type: model.type,
          detectedCapabilities: [...model.detected],
          ...(model.override
            ? { capabilities: [...model.override], capabilitiesOverridden: true }
            : {}),
        },
      });
      const instance = await fixture.runtimeInstance.create({
        data: {
          userId,
          runtimeId: runtime.id,
          versionId: version.id,
          launchVersionId: version.id,
          handle: slug,
          startedBy: "SYSTEM",
          desiredState: null,
          phase: "READY",
        },
      });
      // Degraded by one failed request; its backoff has passed.
      const target = await fixture.executionTarget.create({
        data: {
          userId,
          kind: "INSTANCE_MODEL",
          instanceId: instance.id,
          runtimeModelId: runtimeModel.id,
          health: "DEGRADED",
          lastFailureClass: "UPSTREAM_5XX",
          consecutiveRetryableFailures: 1,
          lastFailureAt: new Date(Date.now() - 60_000),
          nextRetryAt: new Date(Date.now() - 1_000),
        },
      });
      targets[model.key] = target.id;
    }
  });

  afterAll(async () => {
    if (!fixture) return;
    try {
      // Children first, every delete scoped to this run (WHERE).
      await fixture.runtimeInstance.deleteMany({ where: { userId } });
      await fixture.runtime.updateMany({ where: { userId }, data: { currentVersionId: null } });
      await fixture.runtime.deleteMany({ where: { userId } });
      await fixture.user.deleteMany({ where: { id: userId } });
      expect(await fixture.node.count({ where: { userId } })).toBe(0);
    } finally {
      await fixture.$disconnect();
      await prisma?.$disconnect();
    }
  });

  it("finds degraded chat and embeddings targets by their effective capabilities", async () => {
    const due = await recovery.listDueOwnedTargetRecoveries([nodeId], new Date());
    const byId = new Map(due.map((target) => [target.id, target]));
    expect(byId.get(targets.chat)).toMatchObject({
      nodeId,
      upstreamModelId: "m-chat",
      api: "OPENAI",
      type: "LLM",
    });
    expect(byId.get(targets.override)?.type).toBe("LLM");
    expect(byId.get(targets.declared)?.type).toBe("LLM");
    expect(byId.get(targets.embeddings)?.type).toBe("EMBEDDINGS");
    // No safe probe for transcription.
    expect(byId.has(targets.transcription)).toBe(false);
    const embeddings = byId.get(targets.embeddings);
    if (!embeddings) throw new Error("the embeddings target is due");
    expect(recovery.recoveryProbe(embeddings)).toMatchObject({
      family: "embeddings",
      path: "/v1/embeddings",
    });
  });

  it("makes a degraded target healthy again once its probe succeeds", async () => {
    const probed: string[] = [];
    let run: () => void = () => undefined;
    const scheduler = new recovery.TargetRecoveryScheduler({
      getOwnedNodeIds: () => [nodeId],
      listDueTargets: recovery.listDueOwnedTargetRecoveries,
      probe: async (target) => {
        probed.push(target.id);
        // The engine answers; only the embeddings wrap is still failing.
        return target.id !== targets.embeddings;
      },
      setTimer: (callback) => {
        run = callback;
        return setTimeout(() => undefined, 0);
      },
      clearTimer: () => undefined,
    });
    scheduler.wake();
    run();
    // The pass runs asynchronously: wait (bounded) until every probed target is settled.
    const probedIds = [targets.chat, targets.declared, targets.override, targets.embeddings];
    for (let attempt = 0; attempt < 600; attempt++) {
      const settled = await fixture.executionTarget.count({
        where: { id: { in: probedIds }, health: { in: ["HEALTHY", "UNHEALTHY"] } },
      });
      if (settled === probedIds.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    scheduler.stop();
    const rows = await fixture.executionTarget.findMany({
      where: { userId },
      select: { id: true, health: true, consecutiveRetryableFailures: true, nextRetryAt: true },
    });
    const health = new Map(rows.map((row) => [row.id, row]));
    expect(health.get(targets.chat)).toMatchObject({
      health: "HEALTHY",
      consecutiveRetryableFailures: 0,
      nextRetryAt: null,
    });
    expect(health.get(targets.override)?.health).toBe("HEALTHY");
    expect(health.get(targets.declared)?.health).toBe("HEALTHY");
    // A failed probe of a half-open trial: unhealthy, with a later retry.
    expect(health.get(targets.embeddings)?.health).toBe("UNHEALTHY");
    expect(health.get(targets.transcription)?.health).toBe("DEGRADED");
    expect(probed).not.toContain(targets.transcription);
  }, 60_000);
});
