import type { Prisma } from "@ws-model-proxy/db";
import { expect, it, type Mock, vi } from "vitest";
import { generateTestHelloIdentity } from "./relay/hello-identity.js";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_TERMINAL_USER_LIMIT: 8,
    WMP_TERMINAL_CLI_LIMIT: 4,
  },
}));

const connections = vi.hoisted(() => ({ active: 0, peak: 0 }));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { Prisma } = await import("../../../packages/db/prisma/generated/client");
  const { withTransactionSlot } = await import("@ws-model-proxy/db/lock-slots");
  const tx = mockDeep<Prisma.TransactionClient>();
  // Same dispatch boundary as packages/db/src/index.ts: consume one prepaid
  // ticket, or allocate a raw transaction slot BEFORE checking out a connection.
  const transaction = async (work: (client: Prisma.TransactionClient) => Promise<unknown>) =>
    withTransactionSlot(async () => {
      connections.active += 1;
      connections.peak = Math.max(connections.peak, connections.active);
      try {
        expect(connections.active).toBeLessThanOrEqual(2);
        return await work(tx);
      } finally {
        connections.active -= 1;
      }
    });
  return {
    Prisma,
    default: new Proxy(tx, {
      get(target, key, receiver) {
        return key === "$transaction" ? transaction : Reflect.get(target, key, receiver);
      },
    }),
  };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { configureLockSlots, releaseSlots, tryAcquireSlots, withLockSlot } = await import(
  "@ws-model-proxy/db/lock-slots"
);
const { revokeUserCredentials } = await import("../../../packages/auth/src/credential-revocation");
const { onMachineCredentialsRevoked } = await import(
  "@ws-model-proxy/auth/machine-credential-listeners"
);
const { RelaySessionManager } = await import("./relay/session-manager.js");
const { RuntimeLifecycle } = await import("./runtimes/lifecycle.js");
// The memory methods return ordinary promises, not Prisma's lazy relation clients.
// Keep that distinction in the test-facing types as well as at runtime.
type MemoryMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer Args) => infer Result
    ? Mock<(...args: Args) => Promise<Awaited<Result>>>
    : never;
};
type MemoryClient = {
  [K in
    | "node"
    | "nodeCredential"
    | "runtimeInstance"
    | "executionTarget"
    | "verification"
    | "instanceStep"
    | "session"
    | "nodeEnrollmentCode"]: MemoryMethods<Prisma.TransactionClient[K]>;
} & {
  $executeRaw: Mock<() => Promise<number>>;
  $queryRaw: Mock<
    (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
  >;
};
const db = prisma as unknown as MemoryClient;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class MemorySocket {
  readyState = 1;
  bufferedAmount = 0;
  frames: string[] = [];
  closes: string[] = [];
  send(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string") this.frames.push(data);
  }
  close(_code?: number, reason?: string) {
    this.readyState = 3;
    this.closes.push(reason ?? "");
  }
}

it("recovery post-sweep finishes after real disconnect lifecycle returns the borrowed spare", async () => {
  configureLockSlots(3);
  const borrowed = gate();
  const releaseLifecycle = gate();
  const lifecycleFinished = gate();
  const manager = new RelaySessionManager();
  const lifecycle = new RuntimeLifecycle({
    sendToNode: manager.sendToNode.bind(manager),
    nodeSession: manager.nodeSession.bind(manager),
    onlineNodeIds: () => manager.getOnlineNodeIds(),
  });
  // Only the disconnect handler is needed. Stop ticks so the regression models
  // the disconnect write, without starting unrelated background lifecycle passes.
  await lifecycle.stop();
  manager.setNodeFrameHandlers(lifecycle.handlers());
  // Same callback as app.ts; the existing machine-credential-wiring test pins
  // that production registration. Neither close nor nodeDisconnected is spied on.
  const unsubscribe = onMachineCredentialsRevoked((userId) => manager.closeSessionsForUser(userId));
  const identity = generateTestHelloIdentity();
  const socket = new MemorySocket();
  const userId = "recovering";
  const nodeId = "node-1";
  let connection = "ONLINE";
  let epoch = "";
  let state = "RUNNING";
  let revoked = 0;
  let postSweep!: Promise<void>;
  let recovery: Promise<void> | undefined;
  let lifecycleReads = 0;
  const fences: string[][] = [];

  // Narrow rows implement only the fields these production paths select/read.
  // The relay, lifecycle and graph writer use these in-memory model methods.
  db.$executeRaw.mockResolvedValue(0);
  db.$queryRaw.mockImplementation(async (_sql, ...values) => {
    if (Array.isArray(values[0])) fences.push(values[0] as string[]);
    return [{ acquired: true }];
  });
  db.nodeCredential.findUnique.mockResolvedValue({
    revokedAt: null,
    identityPublicKey: identity.publicKey,
    User: { banned: false, banExpires: null, deletionRequestedAt: null },
    Node: { id: nodeId, userId, slug: "box", trust: "FULL", trustLowerRequestedAt: null },
  } as never);
  db.nodeCredential.update.mockResolvedValue({} as never);
  db.node.update.mockResolvedValue({ connectionGeneration: 1 } as never);
  db.node.findUnique.mockResolvedValue({
    id: nodeId,
    userId,
    trust: "FULL",
    trustLowerRequestedAt: null,
    connectionGeneration: 1,
  } as never);
  db.node.updateMany.mockImplementation(async (args) => {
    if (args.data.connection === "OFFLINE") connection = "OFFLINE";
    return { count: 1 };
  });
  db.runtimeInstance.findMany.mockResolvedValue([]);
  db.executionTarget.findMany.mockResolvedValue([]);
  db.verification.findMany.mockResolvedValue([]);
  db.nodeCredential.updateMany.mockImplementation(async () => ({ count: ++revoked }));
  db.instanceStep.findMany.mockImplementation(async (args) => {
    if (state !== "RUNNING" || typeof args?.where?.ownerEpoch !== "string") return [];
    epoch = args.where.ownerEpoch;
    return [{ id: "step-1", instanceId: "instance-1" }] as never;
  });
  db.instanceStep.findFirst.mockImplementation(async (args) => {
    expect(args?.where).toMatchObject({ id: "step-1", ownerEpoch: epoch });
    expect(connections.active).toBe(2); // password holder + real lifecycle transaction
    lifecycleReads += 1;
    borrowed.open();
    await releaseLifecycle.opened;
    return { id: "step-1", state, ownerEpoch: epoch, intent: {}, attempts: 1 } as never;
  });
  db.instanceStep.updateMany.mockImplementation(async (args) => {
    expect(args.where).toMatchObject({ id: "step-1", state: "RUNNING", ownerEpoch: epoch });
    expect(args.data).toMatchObject({ state: "PENDING", ownerEpoch: null });
    state = "PENDING";
    lifecycleFinished.open();
    return { count: 1 };
  });

  try {
    expect(
      manager.acceptAuthenticatedSocket({
        socket,
        identity: { credentialId: "cred-1", userId, nodeId, identityPublicKey: identity.publicKey },
      }),
    ).toBe(true);
    const challenge = socket.frames
      .map((frame) => JSON.parse(frame))
      .find((frame) => frame.type === "hello.challenge");
    const terminalKey = Buffer.alloc(65, 9);
    terminalKey[0] = 0x04;
    await manager.handleTextFrame(
      socket,
      JSON.stringify({
        type: "hello",
        id: "hello-1",
        protocolVersion: "4.0",
        node: {
          slug: "box",
          version: "1.0.0",
          identityPublicKey: identity.publicKey,
          identitySignature: identity.sign(challenge.nonce, "box", "https://proxy.example.com"),
          terminalPublicKey: terminalKey.toString("base64url"),
          build: { commit: null, target: "x86_64-unknown-linux-gnu", installMethod: "script" },
        },
        trust: { value: "full", frozen: false },
        features: {
          terminals: { supported: true, max: 4, approvalRequired: false },
          operatorTerminals: false,
          files: { roots: [], asRoot: false, source: "configured" },
          runtimeHosts: [],
          mediaExpand: false,
          liveStt: false,
          secrets: [],
          jobReservations: true,
          rankIdle: true,
          selfUpdate: { strategies: ["self-replace"], instancesSurvive: true, remote: "allowed" },
        },
        definitions: [],
        heldMetricCommandsHash: null,
        heldPortRange: null,
        heldFabricsHash: null,
      }),
    );
    expect(manager.nodeSession(nodeId)?.connectionGeneration).toBe(1);

    recovery = withLockSlot(
      () =>
        prisma.$transaction(async () => {
          // Real pre-sweep -> production notification -> real manager detach ->
          // lifecycle.nodeDisconnected -> graphWrite -> runCapacityOrderedTransaction.
          await revokeUserCredentials(userId);
          await bounded(borrowed.opened, "real disconnect never borrowed the spare");
          expect(connection).toBe("OFFLINE");
          expect(socket.closes).toEqual(["access_denied"]);
          expect(revoked).toBe(1);
          postSweep = revokeUserCredentials(userId);
          await Promise.resolve();
          expect(revoked).toBe(1); // final sweep is waiting, without checking out
          expect(connections.active).toBe(2);
          expect(tryAcquireSlots()).toBe(false);
          releaseLifecycle.open();
          await bounded(postSweep, "post-sweep deadlocked after lifecycle returned the spare");
        }),
      { nested: 1 },
    );
    await expect(recovery).resolves.toBeUndefined();
    await bounded(lifecycleFinished.opened, "real lifecycle step was not requeued");
    expect(state).toBe("PENDING");
    expect(lifecycleReads).toBe(1);
    expect(fences).toContainEqual([`00:owner:${userId}`]);
    expect(fences).toContainEqual(["08:capacity:instance-1"]);
    expect(revoked).toBe(2);
    expect(db.session.deleteMany).toHaveBeenCalledTimes(2);
    expect(db.nodeEnrollmentCode.updateMany).toHaveBeenCalledTimes(2);
  } finally {
    releaseLifecycle.open();
    await recovery?.catch(() => {});
    await postSweep?.catch(() => {});
    unsubscribe();
    await lifecycle.stop();
    manager.dispose();
  }
  expect(connections.active).toBe(0);
  expect(connections.peak).toBe(2);
  expect(tryAcquireSlots(2)).toBe(true);
  releaseSlots(2);
});
