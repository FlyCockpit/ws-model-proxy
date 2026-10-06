/**
 * Node secrets (owner decision round 3): write-only. The value exists only in this call's input
 * and in the relay `secret.set` frame; it is never stored, logged, audited or returned. Both
 * procedures are in SENSITIVE_INPUT_PROCEDURES (generic input/error logging skips them). The
 * audit row names the secret, never its value.
 */
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { nodesContract as c } from "../contracts/nodes";
import { assertMayWrite, callerActor } from "../lib/caller";
import type { NodeSecretWriteResult } from "../lib/node-relay-services";
import { notFound, refuseAbout } from "../lib/refuse";
import { isFullControl } from "./trust";

async function secretTarget(context: SignedInContext, nodeId: string) {
  assertMayWrite(context.auth);
  const userId = context.session.user.id;
  const node = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: {
      id: true,
      connection: true,
      trust: true,
      trustChangedAt: true,
      trustLowerRequestedAt: true,
    },
  });
  if (!node) throw notFound("Node");
  if (!isFullControl(node))
    throw refuseAbout(
      "secret_needs_node",
      node.id,
      "This node is Relay only: set the secret with `wsmp secret set NAME` on the node.",
    );
  if (node.connection !== "ONLINE")
    throw refuseAbout(
      "node_offline",
      node.id,
      "The node is offline; a secret goes straight to the node, so it must be connected.",
    );
  const writeSecrets = context.services?.nodes?.writeSecrets;
  if (!writeSecrets)
    // TODO(server): wire services.nodes.writeSecrets to the relay `secret.set` frame.
    throw refuseAbout(
      "secret_needs_node",
      node.id,
      "This server cannot send secrets to nodes yet: use `wsmp secret set NAME` on the node.",
      "PRECONDITION_FAILED",
    );
  // The relay's own errors never reach the caller or the generic error log: they could
  // carry the frame (and so the value). A fixed error replaces them.
  const send: typeof writeSecrets = async (request) => {
    try {
      return await writeSecrets(request);
    } catch {
      throw new ORPCError("BAD_GATEWAY", { message: "The node did not answer the secret write." });
    }
  };
  return { userId, node, writeSecrets: send };
}

const SECRET_REFUSALS = ["invalid", "store_failed", "limit"] as const;

function failed(result: NodeSecretWriteResult | undefined, nodeId: string): never {
  if (result?.reason === "trust_relay")
    throw refuseAbout(
      "secret_needs_node",
      nodeId,
      "The node is Relay only: set the secret with `wsmp secret set NAME` on it.",
    );
  // Only a known reason code reaches the message, never text the node sent.
  const reason = SECRET_REFUSALS.find((known) => known === result?.reason) ?? "no answer";
  throw new ORPCError("CONFLICT", { message: `The node did not store the secret (${reason}).` });
}

async function auditSecret(
  context: Context,
  userId: string,
  nodeId: string,
  subject: string,
  note: string | undefined,
): Promise<void> {
  const actor = callerActor(context.auth);
  const now = new Date();
  await prisma.nodeAuditEvent.create({
    data: {
      userId,
      nodeId,
      actor: actor.actor,
      agentTokenId: actor.agentTokenId,
      kind: "node_update",
      subject,
      outcome: "completed",
      reason: note ?? null,
      startedAt: now,
      finishedAt: now,
    },
  });
}

export const secretProcedures = {
  set: contractProcedure(c.secrets.set).handler(async ({ context, input }) => {
    const { userId, node, writeSecrets } = await secretTarget(context, input.nodeId);
    const [result] = await writeSecrets({
      nodeId: node.id,
      set: [{ name: input.name, value: input.value }],
      delete: [],
    });
    if (result?.name !== input.name || result.status !== "set") failed(result, node.id);
    await auditSecret(context, userId, node.id, `secret:set:${input.name}`, input.note);
    return { name: input.name, updatedAt: result.updatedAt ?? new Date().toISOString() };
  }),

  delete: contractProcedure(c.secrets.delete).handler(async ({ context, input }) => {
    const { userId, node, writeSecrets } = await secretTarget(context, input.nodeId);
    const [result] = await writeSecrets({ nodeId: node.id, set: [], delete: [input.name] });
    if (
      result?.name !== input.name ||
      (result.status !== "deleted" && result.status !== "not_found")
    )
      failed(result, node.id);
    await auditSecret(context, userId, node.id, `secret:delete:${input.name}`, input.note);
    return { ok: true as const };
  }),
};
