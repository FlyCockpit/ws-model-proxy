/**
 * `Context.services.runtimeSteps`: what `runtimes.steps.attach/reopen/cancel` need from the
 * server. Attach mints a one-use ticket bound to the step and the operator terminal the node
 * opened for its current dispatch (the browser terminal socket redeems it and attaches, also on
 * a Relay-only node); reopen and cancel are the lifecycle engine's (owner fence, step CHECKs).
 *
 * The procedures are human-only (`humanProcedure`, CSRF); nothing here trusts more than the
 * user id they pass: every lookup is scoped to that owner.
 */
import type {
  RuntimeStepRefusal,
  RuntimeStepResult,
  RuntimeStepServices,
} from "@ws-model-proxy/api/context";
import prisma from "@ws-model-proxy/db";
import type { TerminalTicketStore } from "../relay/terminal-tickets.js";
import { OperatorStepError } from "./lifecycle.js";
import { stepIntentSchema } from "./steps.js";

export type OperatorStepEngine = {
  reopenStep(input: { userId: string; stepId: string }): Promise<void>;
  cancelStep(input: { userId: string; stepId: string }): Promise<void>;
};

export type OperatorStepRelay = {
  operatorStepTerminal(
    stepId: string,
    userId: string,
  ): { nodeId: string; terminalId: string; state: "awaiting" | "running" } | null;
};

async function settle(work: () => Promise<void>): Promise<RuntimeStepResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    if (error instanceof OperatorStepError) return { ok: false, code: error.code };
    throw error;
  }
}

export function createRuntimeStepServices(deps: {
  engine: OperatorStepEngine;
  relay: OperatorStepRelay;
  tickets: TerminalTicketStore;
}): RuntimeStepServices {
  const refuse = (code: RuntimeStepRefusal) => ({ ok: false as const, code });
  return {
    async attach({ userId, sessionId, impersonatedBy, stepId }) {
      const step = await prisma.instanceStep.findFirst({
        where: { id: stepId, Instance: { userId } },
        select: {
          state: true,
          intent: true,
          nodeId: true,
          phase: true,
          operatorTerminalId: true,
          Instance: { select: { startedBy: true } },
        },
      });
      if (!step) return refuse("not_found");
      const intent = stepIntentSchema.safeParse(step.intent);
      if (!intent.success || !intent.data.interactive) return refuse("not_interactive");
      // An agent's start never runs interactively on a Relay-only node (owner decision): a
      // start terminal it got before the node was lowered is not answered there either. (Stops
      // of what runs there are a person's to answer.)
      if (step.Instance.startedBy === "AGENT" && step.phase !== "STOP") {
        const node = await prisma.node.findFirst({
          where: { id: step.nodeId, userId },
          select: { trust: true, trustLowerRequestedAt: true },
        });
        if (node?.trust !== "FULL" || node.trustLowerRequestedAt !== null)
          return refuse("trust_relay");
      }
      if (step.state !== "AWAITING_OPERATOR" && step.state !== "RUNNING")
        return refuse("not_waiting");
      if (step.operatorTerminalId === null)
        return refuse(step.state === "AWAITING_OPERATOR" ? "terminal_closed" : "not_waiting");
      // The node must hold the terminal of exactly this dispatch, with its screen up.
      const live = deps.relay.operatorStepTerminal(stepId, userId);
      if (live?.terminalId !== step.operatorTerminalId || live.nodeId !== step.nodeId)
        return refuse("terminal_unavailable");
      // Defence in depth: the node holding the terminal is the step owner's (the relay checks
      // its live session's user in `operatorStepTerminal`; this checks the node row).
      if ((await prisma.node.count({ where: { id: live.nodeId, userId } })) === 0)
        return refuse("terminal_unavailable");
      const minted = deps.tickets.mint({
        userId,
        sessionId,
        impersonatedBy: impersonatedBy ?? null,
        nodeId: live.nodeId,
        attach: { stepId, terminalId: live.terminalId },
      });
      return { ok: true, ...minted };
    },
    reopen: (input) => settle(() => deps.engine.reopenStep(input)),
    cancel: (input) => settle(() => deps.engine.cancelStep(input)),
  };
}
