/**
 * The relay side of `Context.services.nodes` (lane B hooks): secret writes, rescans, trust
 * lowering and disconnects. Definition pushes and profile applies come from the runtime sync
 * and lifecycle modules; `createNodeRelayServices` takes them as optional parts so `app.ts`
 * builds one object.
 *
 * Secret values exist only in the `secret.set` frame this module sends: they are never logged,
 * stored, kept in the pending map or put into an error.
 */
import { randomBytes } from "node:crypto";
import type {
  NodeRelayServices,
  NodeSecretWriteResult,
} from "@ws-model-proxy/api/lib/node-relay-services";
import prisma from "@ws-model-proxy/db";
import type {
  NodeToServerControlFrame,
  NodeTrustWire,
  ServerToNodeControlFrame,
} from "./frames.js";
import { nodeOwnerMatches } from "./node-owner.js";
import type { NodeFrameHandlers, NodeSessionRef, SendGuard } from "./session-manager.js";

type NodeFrame<T extends NodeToServerControlFrame["type"]> = Extract<
  NodeToServerControlFrame,
  { type: T }
>;

/** How long a secret write waits for its `secret.result`. */
export const SECRET_RESULT_TIMEOUT_MS = 15_000;

export class SecretWriteError extends Error {
  constructor(readonly code: "not_delivered" | "no_answer" | "disconnected") {
    super(`The node did not answer the secret write (${code}).`);
    this.name = "SecretWriteError";
  }
}

type RelayPort = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(
    nodeId: string,
  ): { userId: string; connectionGeneration: number; trust: NodeTrustWire } | null;
  requestTrustLower(nodeId: string, requestedAt: Date): boolean;
  closeSessionsForNodes(nodeIds: readonly string[]): Promise<void>;
};

type PendingSecret = {
  nodeId: string;
  /** The session the frame went to: only it may answer, only its loss fails the write. */
  connectionGeneration: number;
  name: string;
  resolve: (result: NodeSecretWriteResult) => void;
  reject: (error: SecretWriteError) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type NodeServiceParts = Pick<NodeRelayServices, "definitionChanged" | "profileApplied">;

export function createNodeRelayServices(
  relay: RelayPort,
  parts: NodeServiceParts = {},
  options: { secretTimeoutMs?: number } = {},
): {
  services: NodeRelayServices;
  handlers: Pick<NodeFrameHandlers, "secret.result" | "runtime.detected" | "nodeDisconnected">;
} {
  const timeoutMs = options.secretTimeoutMs ?? SECRET_RESULT_TIMEOUT_MS;
  const pending = new Map<string, PendingSecret>();

  const settle = (id: string) => {
    const entry = pending.get(id);
    if (!entry) return null;
    pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  };

  /** Sends one frame and waits for the `secret.result` with its id. */
  const exchange = (
    nodeId: string,
    /** The secret's owner: the node must be theirs. */
    userId: string,
    name: string,
    frame: (id: string) => ServerToNodeControlFrame,
  ): Promise<NodeSecretWriteResult> => {
    const id = `secret-${randomBytes(12).toString("hex")}`;
    return new Promise<NodeSecretWriteResult>((resolve, reject) => {
      const session = relay.nodeSession(nodeId);
      // Offline, or (defence in depth) a node of another owner: the value is never sent.
      if (!session || !nodeOwnerMatches(session, userId, "secret")) {
        reject(new SecretWriteError("not_delivered"));
        return;
      }
      const { connectionGeneration } = session;
      // Lowered meanwhile: the node would refuse it anyway; the value is never sent.
      if (session.trust !== "full") {
        resolve({ name, status: "refused", reason: "trust_relay" });
        return;
      }
      const timer = setTimeout(() => {
        settle(id)?.reject(new SecretWriteError("no_answer"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { nodeId, connectionGeneration, name, resolve, reject, timer });
      // Full control is re-checked on the live session: a lowering that landed after the
      // procedure's check wins, and the value is never sent.
      const guard: SendGuard = {
        connectionGeneration,
        requireFullTrust: true,
        userId,
        ownerCheck: "secret",
      };
      if (!relay.sendToNode(nodeId, frame(id), guard)) {
        settle(id)?.reject(new SecretWriteError("not_delivered"));
      }
    });
  };

  const writeSecrets: NonNullable<NodeRelayServices["writeSecrets"]> = async (input) => {
    const results: NodeSecretWriteResult[] = [];
    // One at a time (the node answers each); a refusal stops the rest.
    for (const entry of input.set) {
      const result = await exchange(input.nodeId, input.userId, entry.name, (id) => ({
        type: "secret.set",
        id,
        name: entry.name,
        value: entry.value,
      }));
      results.push(result);
      if (result.status === "refused") return results;
    }
    for (const name of input.delete) {
      const result = await exchange(input.nodeId, input.userId, name, (id) => ({
        type: "secret.delete",
        id,
        name,
      }));
      results.push(result);
      if (result.status === "refused") return results;
    }
    return results;
  };

  const services: NodeRelayServices = {
    ...parts,
    writeSecrets,
    rescan: async (nodeId) => {
      relay.sendToNode(nodeId, {
        type: "runtime.detect",
        id: `detect-${randomBytes(8).toString("hex")}`,
      });
    },
    lowerTrust: async (nodeId) => {
      relay.requestTrustLower(nodeId, new Date());
    },
    disconnect: async (nodeId) => {
      await relay.closeSessionsForNodes([nodeId]);
    },
  };

  const handlers: Pick<
    NodeFrameHandlers,
    "secret.result" | "runtime.detected" | "nodeDisconnected"
  > = {
    "secret.result": (node: NodeSessionRef, frame: NodeFrame<"secret.result">) => {
      const entry = pending.get(frame.id);
      // Only the session the frame went to may answer it, and only for that name.
      if (
        !entry ||
        entry.nodeId !== node.nodeId ||
        entry.connectionGeneration !== node.connectionGeneration ||
        entry.name !== frame.name
      )
        return;
      settle(frame.id)?.resolve({
        name: frame.name,
        status: frame.status,
        ...(frame.reason ? { reason: frame.reason } : {}),
        ...(frame.updatedAt ? { updatedAt: frame.updatedAt } : {}),
      });
    },
    "runtime.detected": async (node: NodeSessionRef, frame: NodeFrame<"runtime.detected">) => {
      // Status columns: no graph fence. The generation guard drops a stale session's scan; the
      // time is the server's (a node clock is not trusted for ordering).
      await prisma.node.updateMany({
        where: { id: node.nodeId, connectionGeneration: node.connectionGeneration },
        data: { detectedServers: frame.servers, detectedServersAt: new Date() },
      });
    },
    nodeDisconnected: (node: NodeSessionRef) => {
      for (const [id, entry] of pending) {
        // A late notice about an earlier session leaves writes to the new one alone.
        if (
          entry.nodeId === node.nodeId &&
          entry.connectionGeneration === node.connectionGeneration
        )
          settle(id)?.reject(new SecretWriteError("disconnected"));
      }
    },
  };

  return { services, handlers };
}
