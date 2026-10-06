/**
 * `runtimes.steps.*`: a person answers an interactive step (spec §3.6, §4.7). Attach returns a
 * one-use ticket for the operator terminal the node opened for the step; reopen runs the step
 * again in a fresh terminal after it closed without success; cancel gives up on it (the step
 * fails `operator_cancelled` and the instance follows its stop/restart rules).
 *
 * Human-only on every node, Relay-only ones included (contract access `human`: never on MCP,
 * never for a token, CSRF required). Agents can neither answer, reopen nor cancel a step. The
 * work is the server's (`Context.services.runtimeSteps`); without it nothing changes.
 */
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import type { Context, RuntimeStepRefusal, RuntimeStepServices } from "../context";
import { contractProcedure } from "../contract-procedure";
import { runtimesContract as c } from "../contracts/runtimes";
import { notFound, refuse } from "../lib/refuse";
import { runtimeSpecSchema } from "../lib/runtime-spec";
import { stepView } from "../lib/runtime-views";

function services(context: Context): RuntimeStepServices {
  const steps = context.services?.runtimeSteps;
  if (!steps)
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Interactive steps are not available on this server.",
    });
  return steps;
}

const REFUSAL_MESSAGES: Record<Exclude<RuntimeStepRefusal, "not_found">, string> = {
  not_interactive: "This step does not run in a terminal.",
  not_waiting: "This step does not wait for you.",
  running: "The command is running in its terminal; it finishes there.",
  superseded: "The instance stopped or restarted since; this step no longer runs.",
  terminal_closed: "The terminal closed. Reopen the step to run it again.",
  terminal_unavailable:
    "The terminal is not open on the node yet, or the node is offline. Try again shortly.",
  trust_relay:
    "An agent started this runtime and its node is Relay only: its steps do not run there.",
};

function refusal(code: RuntimeStepRefusal): ORPCError<string, unknown> {
  if (code === "not_found") return notFound("That step does not exist.");
  if (code === "trust_relay") return refuse("trust_relay", REFUSAL_MESSAGES[code], "FORBIDDEN");
  return new ORPCError("CONFLICT", { message: REFUSAL_MESSAGES[code], data: { code } });
}

/** The step as people see it: the launched version's command text and its author. */
async function ownedStepView(userId: string, stepId: string) {
  const step = await prisma.instanceStep.findFirst({
    where: { id: stepId, Instance: { userId } },
    include: { Instance: { select: { LaunchVersion: { select: { spec: true, editor: true } } } } },
  });
  if (!step) throw notFound("That step does not exist.");
  const spec = runtimeSpecSchema.safeParse(step.Instance.LaunchVersion.spec);
  return stepView(step, spec.success ? spec.data : null, step.Instance.LaunchVersion.editor);
}

export const runtimeSteps = {
  attach: contractProcedure(c.steps.attach).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const result = await services(context).attach({
      userId,
      sessionId: context.session.session.id,
      impersonatedBy: context.session.session.impersonatedBy ?? null,
      stepId: input.stepId,
    });
    if (!result.ok) throw refusal(result.code);
    // The terminal keeps its own size: the node sizes it from the attached viewers.
    return {
      step: await ownedStepView(userId, input.stepId),
      ticket: result.ticket,
      terminalId: result.terminalId,
      expiresAt: result.expiresAt.toISOString(),
    };
  }),
  reopen: contractProcedure(c.steps.reopen).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const result = await services(context).reopen({ userId, stepId: input.stepId });
    if (!result.ok) throw refusal(result.code);
    return ownedStepView(userId, input.stepId);
  }),
  cancel: contractProcedure(c.steps.cancel).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const result = await services(context).cancel({ userId, stepId: input.stepId });
    if (!result.ok) throw refusal(result.code);
    return ownedStepView(userId, input.stepId);
  }),
};
