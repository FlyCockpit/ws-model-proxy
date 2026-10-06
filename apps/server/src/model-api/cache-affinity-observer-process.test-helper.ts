// Standalone child-process proof, not a Vitest suite.

import type { AddressInfo } from "node:net";
import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { purgeDeletedUserHistory } from "@ws-model-proxy/db/hot-path-sweeps";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { WebSocket, WebSocketServer } from "ws";
import { generateTestHelloIdentity } from "../relay/hello-identity.js";
import { encodeRelayBinaryFrame, RELAY_PROTOCOL_VERSIONS } from "../relay/protocol.js";
import { RelaySessionManager } from "../relay/session-manager.js";
import {
  buildAffinityTargetIdentity,
  rankAffinityTargets,
  rememberAffinity,
} from "./cache-affinity.js";
import { captureAffinityTargetGenerations } from "./cache-affinity-residency.js";
import { startAuthorizedLocalRelayAttempt } from "./local-send.js";

/**
 * `quiet`: the parent keeps its own signing device connected (it drives the reset), so its
 * observer is never retired and this child must not wait for that.
 */
const config = JSON.parse(process.argv[2]!) as {
  contributorId: string;
  capacityId: string;
  quiet?: boolean;
};
const db = createFixturePrismaClient(process.env.DATABASE_URL!);
const strict = createPrismaClient(process.env.DATABASE_URL!);
const owner = await db.user.create({
  data: { email: `core-child-${crypto.randomUUID()}@example.test`, name: "Core child proof" },
});
const token = await db.cliToken.create({
  data: {
    userId: config.contributorId,
    name: "core-child",
    lookupPrefix: crypto.randomUUID(),
    secretDigest: crypto.randomUUID(),
  },
});
const manager = new RelaySessionManager();
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.once("listening", resolve));
let socket: WebSocket | undefined;
server.on("connection", (ws) => {
  socket = ws;
  manager.acceptAuthenticatedSocket({
    socket: ws,
    identity: {
      kind: "cliToken",
      id: token.id,
      userId: config.contributorId,
      lookupPrefix: token.lookupPrefix,
      cliDeviceId: null,
    },
  });
  ws.on("message", (data, binary) => {
    void (binary
      ? manager.handleBinaryFrame(ws, new Uint8Array(data as Buffer).buffer)
      : manager.handleTextFrame(ws, data.toString()));
  });
});
const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
const identity = generateTestHelloIdentity();
const frames: Record<string, unknown>[] = [];
client.on("message", (data, binary) => {
  if (binary) return;
  const f = JSON.parse(data.toString()) as Record<string, unknown>;
  frames.push(f);
  if (f.type === "hello.challenge")
    client.send(
      JSON.stringify({
        type: "hello",
        id: "core-child",
        protocolVersion: RELAY_PROTOCOL_VERSIONS[0],
        cli: {
          slug: "independent-child",
          hostname: "proof",
          identityPublicKey: identity.publicKey,
          identitySignature: identity.sign(String(f.nonce), "independent-child", String(f.origin)),
          capabilities: {
            terminalPublicKey: identity.publicKey,
            features: {
              humanTerminal: false,
              mcpCommandMode: "off",
              terminalApproval: false,
              terminalSupported: false,
              remoteMetricSources: false,
              remoteEngineAdapters: false,
              mcpFileRead: false,
              fileRootsConfigured: false,
              allowFileToolsAsRoot: false,
            },
          },
        },
        endpoints: [
          {
            slug: "independent-child-engine",
            label: "same physical engine",
            kind: "openai-compatible",
            status: "online",
            defaultCapabilities: {
              version: 1,
              protocol: "openai-compatible",
              chatCompletions: { supported: true, streaming: true },
            },
            models: [{ slug: "send-fixture-model", upstreamModelId: "send-fixture-model" }],
          },
        ],
      }),
    );
});
async function until(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`child boundary timeout ${JSON.stringify(frames)}`);
}
try {
  await until(() => manager.getActiveCliDeviceIds().length === 1);
  const cliDeviceId = manager.getActiveCliDeviceIds()[0]!;
  const endpoint = await db.endpoint.findFirstOrThrow({ where: { cliDeviceId } });
  const model = await db.discoveredModel.findFirstOrThrow({ where: { endpointId: endpoint.id } });
  await db.endpoint.update({ where: { id: endpoint.id }, data: { published: true } });
  await db.discoveredModel.update({ where: { id: model.id }, data: { published: true } });
  const target = await db.executionTarget.update({
    where: { discoveredModelId: model.id },
    data: { inferenceCapacityId: config.capacityId, capacityAssignmentSource: "OWNER" },
  });
  const capacity = await db.inferenceCapacity.findUniqueOrThrow({
    where: { id: config.capacityId },
  });
  const pool = await db.modelPool.create({
    data: { userId: owner.id, name: "child", slug: "child" },
  });
  const grant = await db.inferenceContribution.create({
    data: {
      poolId: pool.id,
      poolOwnerUserId: owner.id,
      contributorUserId: config.contributorId,
      discoveredModelId: model.id,
      expiresAt: new Date(Date.now() + 600000),
    },
  });
  await db.inferenceContribution.update({
    where: { id: grant.id },
    data: { state: "ACTIVE", acceptedAt: new Date() },
  });
  const member = await db.poolMember.create({
    data: {
      poolId: pool.id,
      discoveredModelId: model.id,
      executionTargetId: target.id,
      inferenceContributionId: grant.id,
    },
  });
  const targetIdentity = buildAffinityTargetIdentity({
    executionTargetId: target.id,
    endpointIdentity: endpoint.id,
    upstreamModelId: model.upstreamModelId,
    runtimeIdentityKey: capacity.runtimeIdentityKey,
    runtimeModel: capacity.runtimeModel,
    runtimeRevision: capacity.runtimeRevision,
    tokenizer: capacity.tokenizer,
    tokenizerVersion: capacity.tokenizerVersion,
    template: capacity.template,
    templateVersion: capacity.templateVersion,
    engine: capacity.engine,
    cacheNamespace: capacity.cacheNamespace,
    requestedSurface: "openai-chat",
    nativeSurface: "openai-chat",
    mode: "legacy-native",
    adapterVersion: "native",
  });
  const [captured] = await captureAffinityTargetGenerations([
    {
      executionTargetId: target.id,
      poolMemberId: member.id,
      capacityId: capacity.id,
      targetIdentity,
      hardConcurrencyLimit: null,
      healthPenalty: 0,
      publicEgressPenalty: 0,
      costPenalty: 0,
    },
  ]);
  const args = {
    ownerId: owner.id,
    resourceOwnerId: owner.id,
    poolId: pool.id,
    policy: {
      enabled: true,
      ttlSeconds: 600,
      maxRecords: 100,
      prefixWeight: 100,
      conversationWeight: 150,
      confirmedCacheWeight: 250,
      loadPenaltyWeight: 100,
    },
    surface: "openai-chat",
    payload: {
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "answer" },
        { role: "user", content: "followup" },
      ],
    },
    target: captured!,
    estimatedTokens: 100,
  };
  await until(
    async () =>
      (await captureAffinityTargetGenerations([captured!]))[0]?.cacheGeneration !==
      "unknown-observed-reset",
  );
  const [readyTarget] = await captureAffinityTargetGenerations([captured!]);
  args.target = readyTarget!;
  await rememberAffinity(args);
  const before = (
    await rankAffinityTargets({ ...args, targets: [args.target], scoreSingleTarget: true })
  ).scores[target.id];
  process.send?.({
    type: "ready",
    before,
    cliDeviceId,
    targetId: target.id,
    userId: owner.id,
    generation: args.target.cacheGeneration,
  });
  await new Promise<void>((resolve) => process.once("message", () => resolve()));
  const after = (
    await rankAffinityTargets({ ...args, targets: [captured!], scoreSingleTarget: true })
  ).scores[target.id];
  const binding = {
    requesterUserId: owner.id,
    engineOwnerUserId: config.contributorId,
    discoveredModelId: model.id,
    executionTargetId: target.id,
    capacityId: capacity.id,
    endpointId: endpoint.id,
    cliDeviceId,
    endpointSlug: endpoint.slug,
    upstreamModelId: model.upstreamModelId,
    pool: {
      id: pool.id,
      ownerUserId: owner.id,
      accessGrantId: null,
      memberId: member.id,
      contributionId: grant.id,
    },
  };
  const attempt = await startAuthorizedLocalRelayAttempt(
    binding,
    {
      manager,
      cliDeviceId,
      endpointSlug: endpoint.slug,
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: new Headers({ "content-type": "application/json" }),
      body: new TextEncoder().encode("{}"),
      timeoutMs: 5000,
    },
    strict,
  );
  await until(() => frames.some((f) => f.type === "relay.request"));
  client.send(
    JSON.stringify({
      type: "relay.response.headers",
      requestId: attempt.requestId,
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  client.send(
    encodeRelayBinaryFrame(
      { type: "relay.response.body", requestId: attempt.requestId, chunkId: "0" },
      new TextEncoder().encode('{"choices":[{"message":{"content":"pong"}}]}'),
    ),
  );
  client.send(
    JSON.stringify({
      type: "relay.complete",
      requestId: attempt.requestId,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }),
  );
  await (await attempt.started).body.getReader().read();
  const terminal = await attempt.terminal;
  let staleRejected = false;
  try {
    await rememberAffinity(args);
  } catch {
    staleRejected = true;
  }
  if (!config.quiet)
    await until(
      async () =>
        (
          await db.cacheAffinityObserver.findMany({
            where: {
              capacityId: capacity.id,
              cliDeviceId: { not: cliDeviceId },
              retired: false,
            },
          })
        ).length === 0,
    );
  const [freshTarget] = await captureAffinityTargetGenerations([captured!]);
  await rememberAffinity({ ...args, target: freshTarget! });
  const fresh = (
    await rankAffinityTargets({ ...args, targets: [freshTarget!], scoreSingleTarget: true })
  ).scores[target.id];
  process.send?.({
    type: "result",
    before,
    after,
    staleRejected,
    fresh,
    generation: (await captureAffinityTargetGenerations([captured!]))[0]!.cacheGeneration,
    actualAuthorizedSend: terminal.ok,
    pid: process.pid,
  });
} finally {
  client.terminate();
  socket?.terminate();
  manager.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await purgeDeletedUserHistory(strict, owner.id);
  await db.user.delete({ where: { id: owner.id } });
  await db.$disconnect();
  await strict.$disconnect();
  process.disconnect?.();
}
process.exit(0);
