import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL fixture required");
const integration = databaseUrl ? describe : describe.skip;
type Client = ReturnType<typeof import("@ws-model-proxy/db/client-factory").createPrismaClient>;

integration("live transcription usage rows on PostgreSQL", () => {
  let fixture: Client;
  let strict: Client;
  let metering: typeof import("./metering.js");
  let retention: typeof import("../usage-retention.js");
  const users: string[] = [];

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = "test";
    process.env.BETTER_AUTH_SECRET = "realtime-metering-fixture-secret-not-production";
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    const factory = await import("@ws-model-proxy/db/client-factory");
    fixture = (await import("@ws-model-proxy/db/test-fixture-client")).createFixturePrismaClient(
      databaseUrl,
    );
    strict = factory.createPrismaClient(databaseUrl);
    metering = await import("./metering.js");
    retention = await import("../usage-retention.js");
  });

  afterAll(async () => {
    if (!databaseUrl) return;
    const { purgeDeletedUserHistory } = await import("@ws-model-proxy/db/hot-path-sweeps");
    for (const id of users) {
      await purgeDeletedUserHistory(strict, id);
      await fixture.user.delete({ where: { id } });
    }
    await Promise.all([fixture?.$disconnect(), strict?.$disconnect()]);
  });

  async function user() {
    const id = randomUUID();
    const row = await fixture.user.create({
      data: { name: "realtime-meter", email: `${id}@example.test`, slug: `rt-${id}` },
    });
    users.push(row.id);
    return row;
  }

  function directCandidate(ownerUserId: string) {
    return {
      cliDeviceId: "cli",
      endpointSlug: "inst-aaaaaaaaaaaaaaaa",
      upstreamModel: "whisper",
      capabilities: null,
      deploymentManaged: true,
      memberId: null,
      route: {
        kind: "direct" as const,
        poolId: null,
        poolMemberId: null,
        discoveredModelId: randomUUID(),
        endpointId: randomUUID(),
        executionTargetId: `et-${randomUUID()}`,
        capacityId: "cap",
        ownerUserId,
        engineOwnerUserId: ownerUserId,
        accessGrantId: null,
        contributionId: null,
      },
    };
  }

  it("writes one row and one rollup per session, with audio and engine tokens", async () => {
    const requester = await user();
    const times = [new Date("2026-10-05T10:00:00.000Z"), new Date("2026-10-05T10:02:00.000Z")];
    const meter = new metering.RealtimeSessionMeter(
      { userId: requester.id, tokenId: `token-${randomUUID()}`, tokenLookupPrefix: "wsmp_model_x" },
      strict,
      () => times.shift() ?? new Date(),
    );
    const candidate = directCandidate(requester.id);
    meter.opened(candidate);
    meter.itemFinished({
      itemSeq: 0,
      itemId: "item_a",
      status: "completed",
      audioBytes: 240_000,
      audioSeconds: 5,
      transcriptBytes: 30,
      engineUsage: { inputTokens: 40, outputTokens: 9 },
    });
    meter.itemFinished({
      itemSeq: 1,
      itemId: "item_b",
      status: "failed",
      audioBytes: 0,
      audioSeconds: 0,
      code: "engine_error",
      transcriptBytes: 0,
    });
    meter.ended({ candidate, closeCode: null, errorCode: null, sentAudioBytes: 480_000 });
    // A second end (never happens; the session ends once) must not double count.
    meter.ended({ candidate, closeCode: 1011, errorCode: "x", sentAudioBytes: 1 });
    await metering.flushRealtimeMetering();

    const rows = await strict.relayRequest.findMany({ where: { userId: requester.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "SUCCEEDED",
      operation: "audio.realtime_transcription",
      source: "API_TOKEN",
      durationMs: 120_000,
      httpStatusCode: 200,
      requestBytes: 480_000n,
      responseBytes: 30n,
      audioInputMs: 10_000,
      usageKnown: true,
      promptTokens: 40,
      completionTokens: 9,
      totalTokens: 49,
      selectedExecutionTargetId: candidate.route.executionTargetId,
      requestedExecutionTargetId: candidate.route.executionTargetId,
      resourceOwnerUserId: requester.id,
    });

    const minute = await strict.usageRollupMinute.findMany({
      where: { requesterUserId: requester.id },
    });
    expect(minute).toHaveLength(1);
    expect(minute[0]).toMatchObject({
      requests: 1,
      successes: 1,
      audioInputMs: 10_000n,
      inputTokens: 40n,
      outputTokens: 9n,
      // Session wall time is not request latency.
      durationCount: 0,
      durationSumMs: 0n,
      executionTargetId: candidate.route.executionTargetId,
    });

    // Retention: compaction carries the audio into the hourly rollup.
    await retention.compactMinuteRollups({
      prisma: strict,
      now: new Date("2026-11-10T00:00:00.000Z"),
    });
    const hour = await strict.usageRollupHour.findMany({
      where: { requesterUserId: requester.id },
    });
    expect(hour).toHaveLength(1);
    expect(hour[0]).toMatchObject({ requests: 1, audioInputMs: 10_000n });
  }, 20_000);

  it("a session ended by the server is a failed request with its status", async () => {
    const requester = await user();
    const meter = new metering.RealtimeSessionMeter(
      { userId: requester.id, tokenId: `token-${randomUUID()}`, tokenLookupPrefix: "wsmp_model_y" },
      strict,
    );
    const candidate = directCandidate(requester.id);
    meter.opened(candidate);
    meter.ended({
      candidate,
      closeCode: 1011,
      errorCode: "upstream_disconnected",
      sentAudioBytes: 96_000,
    });
    await metering.flushRealtimeMetering();
    const [row] = await strict.relayRequest.findMany({ where: { userId: requester.id } });
    expect(row).toMatchObject({
      status: "FAILED",
      httpStatusCode: 502,
      errorClass: "upstream_disconnected",
      audioInputMs: 2_000,
      usageKnown: false,
      promptTokens: null,
    });
    const [minute] = await strict.usageRollupMinute.findMany({
      where: { requesterUserId: requester.id },
    });
    expect(minute).toMatchObject({ requests: 1, errors: 1, audioInputMs: 2_000n });
  }, 20_000);
  it("a pool session is the pool owner's usage and survives the requester drain", async () => {
    const owner = await user();
    const requester = await user();
    const suffix = randomUUID();
    const device = await fixture.cliDevice.create({
      data: { userId: owner.id, slug: `device-${suffix}` },
    });
    const endpoint = await fixture.endpoint.create({
      data: {
        userId: owner.id,
        cliDeviceId: device.id,
        slug: `inst-${suffix.slice(0, 8)}`,
        label: "asr",
      },
    });
    const pool = await fixture.modelPool.create({
      data: { userId: owner.id, slug: `rt-${suffix.slice(0, 8)}`, name: "realtime" },
    });
    const model = await fixture.discoveredModel.create({
      data: {
        userId: owner.id,
        endpointId: endpoint.id,
        upstreamModelId: "whisper",
        encodedModelId: `whisper-${suffix}`,
      },
    });
    const target = await fixture.executionTarget.findUniqueOrThrow({
      where: { discoveredModelId: model.id },
    });
    const member = await fixture.poolMember.create({
      data: { poolId: pool.id, executionTargetId: target.id, discoveredModelId: model.id },
    });
    const poolCandidate = {
      ...directCandidate(owner.id),
      memberId: member.id,
      route: {
        ...directCandidate(owner.id).route,
        kind: "pool" as const,
        poolId: pool.id,
        poolMemberId: member.id,
        discoveredModelId: model.id,
        endpointId: endpoint.id,
        executionTargetId: target.id,
      },
    };
    const meter = new metering.RealtimeSessionMeter(
      { userId: requester.id, tokenId: `token-${randomUUID()}`, tokenLookupPrefix: "wsmp_model_z" },
      strict,
    );
    meter.opened(poolCandidate);
    meter.ended({
      candidate: poolCandidate,
      closeCode: null,
      errorCode: null,
      sentAudioBytes: 144_000,
    });
    await metering.flushRealtimeMetering();
    const [row] = await strict.relayRequest.findMany({ where: { userId: requester.id } });
    expect(row).toMatchObject({
      requestedModelPoolId: pool.id,
      selectedPoolMemberId: member.id,
      fallbackRoute: "local",
      resourceOwnerUserId: owner.id,
      audioInputMs: 3_000,
    });
    // The requester's deletion merges their rows into the '' requester,
    // keeping the owner's audio total.
    // (The deleted-user purge runs the requester merge.)
    const { purgeDeletedUserHistory } = await import("@ws-model-proxy/db/hot-path-sweeps");
    await purgeDeletedUserHistory(strict, requester.id);
    expect(await strict.usageRollupMinute.count({ where: { requesterUserId: requester.id } })).toBe(
      0,
    );
    const merged = await strict.usageRollupMinute.findMany({
      where: { ownerUserId: owner.id, requesterUserId: "" },
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ requests: 1, audioInputMs: 3_000n, poolId: pool.id });
  }, 20_000);
});
