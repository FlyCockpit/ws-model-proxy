import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { escapeForDisplay } from "@ws-model-proxy/config/display-escape";
import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import { Button, buttonVariants } from "@ws-model-proxy/ui/components/button";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { CircleAlert, RotateCcw, SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

type Instance = Awaited<
  ReturnType<AppRouterClient["deployments"]["listInstances"]>
>["items"][number];
type OperatorStep = Instance["operatorSteps"][number];

/** Hold and error codes the dashboard explains; anything else is shown as its code. */
const STEP_REASON_KEYS: Record<string, string> = {
  operator_capability_missing: "deploymentOperator.reasons.capabilityMissing",
  operator_session_full: "deploymentOperator.reasons.sessionFull",
  operator_node_full: "deploymentOperator.reasons.nodeFull",
  operator_terminals_disabled: "deploymentOperator.reasons.capabilityMissing",
  operator_terminal_failed: "deploymentOperator.reasons.terminalFailed",
  operator_terminal_limit: "deploymentOperator.reasons.terminalLimit",
  operator_terminal_conflict: "deploymentOperator.reasons.terminalFailed",
  operator_terminal_unavailable: "deploymentOperator.reasons.terminalFailed",
  operator_unverified: "deploymentOperator.reasons.unverified",
  held_unknown_probe: "deploymentOperator.reasons.heldCheck",
};

/** A hold (what the person must do on the node) or error code, in the person's words. */
function stepReasonText(
  code: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const key = STEP_REASON_KEYS[code];
  return key ? t(key) : t("deploymentOperator.reasons.other", { code });
}

function useLang() {
  const params = useParams({ strict: false });
  return isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
}

/** What a step waits on, in the person's words. */
function stepStatusKey(step: OperatorStep): string {
  if (step.state === "RUNNING")
    return step.overdue ? "deploymentOperator.status.overdue" : "deploymentOperator.status.running";
  if (step.state === "AWAITING_OPERATOR")
    return step.terminalOpen
      ? "deploymentOperator.status.waitingTerminal"
      : "deploymentOperator.status.closed";
  if (step.heldResourceCheck) return "deploymentOperator.status.heldCheck";
  return "deploymentOperator.status.pending";
}

/**
 * A deployment's "needs you" state: its need badge, the steps a person runs (waiting in a
 * terminal, closed and reopenable, running, overdue, or held with a reason), resources held
 * until an earlier stop is confirmed, and the human-only actions (open the terminal, reopen a
 * closed step, restart a stopped interactive start). The server refuses these actions for
 * agents; commands are shown escaped, exactly as the node's confirm screen shows them.
 */
export function InstanceOperatorPanel({ instance }: { instance: Instance }) {
  const { t } = useTranslation("dashboard");
  const lang = useLang();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.deployments.key() });
  const reopen = useMutation(
    orpc.deployments.reopenOperatorStep.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const restart = useMutation(
    orpc.deployments.restartInstance.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const held = instance.Nodes.filter((node) => !node.claimHeld && node.heldUnknownSince);
  const steps = instance.operatorSteps;
  if (!instance.needsOperator && steps.length === 0 && held.length === 0) return null;
  return (
    <div className="min-w-0 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      {instance.needsOperator ? (
        <p className="flex items-center gap-2 font-medium" role="status">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-amber-600" />
          {t(
            instance.needsOperator === "RESTART"
              ? "deploymentOperator.needRestart"
              : "deploymentOperator.needStep",
          )}
        </p>
      ) : null}
      {steps.length ? (
        <ul className="min-w-0 space-y-2" aria-label={t("deploymentOperator.stepsLabel")}>
          {steps.map((step) => (
            <li key={step.stepId} className="min-w-0 space-y-1 rounded border bg-background p-2">
              <p className="break-words">
                {t("deploymentOperator.stepTitle", {
                  action: t(`deploymentOperator.actions.${step.action}`, {
                    defaultValue: step.action,
                  }),
                  rank: step.rank,
                  node: step.nodeId,
                })}
                {" · "}
                <span
                  className={step.overdue ? "font-medium text-amber-700 dark:text-amber-300" : ""}
                >
                  {t(stepStatusKey(step))}
                </span>
              </p>
              {step.command ? (
                <pre className="min-w-0 whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
                  {escapeForDisplay(step.command)}
                </pre>
              ) : null}
              {step.command ? (
                <p
                  className={cn(
                    "break-words",
                    step.author === "agent"
                      ? "font-medium text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground",
                  )}
                >
                  {t(`deploymentOperator.author.${step.author}`)}
                </p>
              ) : null}
              {(step.hold ?? step.errorCode) ? (
                <p className="break-words text-muted-foreground">
                  {stepReasonText(step.hold ?? step.errorCode ?? "", t)}
                </p>
              ) : null}
              {step.lastExit !== null ? (
                <p className="text-muted-foreground">
                  {t("deploymentOperator.lastExit", { code: step.lastExit })}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {step.terminalOpen || step.state === "RUNNING" ? (
                  <Link
                    to="/$lang/dashboard/terminals"
                    params={{ lang }}
                    className={cn(buttonVariants({ size: "touch", variant: "outline" }), "gap-2")}
                  >
                    <SquareTerminal aria-hidden="true" className="size-4" />
                    {t("deploymentOperator.openTerminal")}
                  </Link>
                ) : null}
                {step.state === "AWAITING_OPERATOR" && !step.terminalOpen ? (
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    disabled={reopen.isPending}
                    onClick={() => reopen.mutate({ stepId: step.stepId })}
                  >
                    {t("deploymentOperator.reopen")}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {held.length ? (
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{t("deploymentOperator.heldTitle")}</p>
          <ul className="space-y-1">
            {held.map((node) => (
              <li key={node.id} className="break-words">
                {t("deploymentOperator.heldNode", {
                  node: node.cliDeviceId,
                  rank: node.rank,
                  port: node.port,
                })}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground">{t("deploymentOperator.heldHint")}</p>
        </div>
      ) : null}
      {instance.needsOperator === "RESTART" ? (
        <Button
          type="button"
          size="touch"
          className="gap-2"
          disabled={restart.isPending}
          onClick={() => restart.mutate({ instanceId: instance.id })}
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {t("deploymentOperator.restart")}
        </Button>
      ) : null}
      {reopen.isError || restart.isError ? (
        <p role="alert">{operatorErrorText(reopen.error ?? restart.error, t)}</p>
      ) : null}
    </div>
  );
}

function operatorErrorText(error: unknown, t: (key: string) => string): string {
  const data = (error as { data?: unknown } | null)?.data;
  const reason =
    data && typeof data === "object" ? (data as { reason?: unknown }).reason : undefined;
  if (reason === "deployment_stop_pending") return t("deployments.stopPending");
  return friendly(error, t("deployments.failed"));
}

const planOperatorSchema = z.object({
  warnings: z.array(z.string()).default([]),
  operatorSteps: z
    .array(
      z.object({
        instanceId: z.string().nullable(),
        nodeId: z.string(),
        rank: z.number(),
        action: z.string(),
        command: z.string(),
        nodeReady: z.boolean(),
      }),
    )
    .default([]),
  operatorStepCount: z.number().optional(),
});

/**
 * The commands a person will run in operator terminals if this plan is applied, so the
 * confirmation names them (design §7): the start's interactive steps and stop, and the
 * interactive stops of deployments it stops (a stop on a node that cannot open terminals now
 * waits there).
 */
export function PlanOperatorSteps({ contents }: { contents: unknown }) {
  const { t } = useTranslation("dashboard");
  const parsed = planOperatorSchema.safeParse(contents);
  if (!parsed.success || parsed.data.operatorSteps.length === 0) return null;
  const { operatorSteps, operatorStepCount } = parsed.data;
  return (
    <div
      role="note"
      className="min-w-0 space-y-2 rounded-md border border-state-warning/40 bg-state-warning/10 p-3 text-sm"
    >
      <p className="font-medium">{t("deployments.operatorRequired")}</p>
      <ul className="min-w-0 space-y-2" data-testid="plan-operator-steps">
        {operatorSteps.map((step, index) => (
          // Every new group's steps have no instance yet: the row index keeps keys unique.
          <li
            key={`${index}:${step.instanceId ?? "new"}:${step.nodeId}:${step.rank}:${step.action}`}
            className="min-w-0"
          >
            <p className="break-words">
              {t(
                step.instanceId ? "deploymentOperator.planStopStep" : "deploymentOperator.planStep",
                {
                  action: t(`deploymentOperator.actions.${step.action}`, {
                    defaultValue: step.action,
                  }),
                  rank: step.rank,
                  node: step.nodeId,
                  instance: step.instanceId ?? "",
                },
              )}
            </p>
            <pre className="min-w-0 whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">
              {escapeForDisplay(step.command)}
            </pre>
            {step.nodeReady ? null : (
              <p className="text-muted-foreground">{t("deployments.operatorNodeNotReady")}</p>
            )}
          </li>
        ))}
      </ul>
      {operatorStepCount && operatorStepCount > operatorSteps.length ? (
        <p>
          {t("deploymentOperator.moreSteps", { count: operatorStepCount - operatorSteps.length })}
        </p>
      ) : null}
    </div>
  );
}

type InteractiveWarning = {
  variant: string;
  rank: number | null;
  command: string;
  reason: string;
};

/** Interactive marks the saved recipe carries that never take effect (IC1-3). */
export function RecipeInteractiveWarnings({ warnings }: { warnings: InteractiveWarning[] }) {
  const { t } = useTranslation("dashboard");
  if (!warnings.length) return null;
  return (
    <ul
      role="note"
      className="min-w-0 space-y-1 rounded-md border border-state-warning/40 bg-state-warning/10 p-3 text-sm"
    >
      {warnings.map((warning) => (
        <li
          key={`${warning.variant}:${warning.rank ?? "all"}:${warning.command}`}
          className="break-words"
        >
          {t("deployments.interactiveFlagUnused", {
            command: warning.command,
            variant: warning.variant,
          })}{" "}
          {t(`deploymentOperator.unusedReasons.${warning.reason}`, { defaultValue: "" })}
        </li>
      ))}
    </ul>
  );
}
