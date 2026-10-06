import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
export type OperatorStepView = RuntimeDetail["instanceList"][number]["openSteps"][number];

/** Why a step waits before its terminal opens (`InstanceStep.operatorHold`, as errorCode). */
const HOLDS: ReadonlySet<string> = new Set([
  "operator_capability_missing",
  "operator_session_full",
  "operator_node_full",
  "operator_terminals_disabled",
]);

/** What the step waits for, as one translation key. */
export function operatorStepStatusKey(step: OperatorStepView): string {
  if (step.state === "PENDING")
    return step.errorCode && HOLDS.has(step.errorCode)
      ? `terminals:steps.hold.${step.errorCode}`
      : "terminals:steps.queued";
  if (step.state === "RUNNING")
    return step.terminalOpen ? "terminals:steps.running" : "terminals:steps.queued";
  if (step.state === "AWAITING_OPERATOR")
    return step.terminalOpen
      ? "terminals:steps.waiting"
      : step.errorCode && HOLDS.has(step.errorCode)
        ? `terminals:steps.hold.${step.errorCode}`
        : "terminals:steps.closed";
  return "terminals:steps.done";
}

/**
 * One interactive step waiting for its person: the exact command (from the launched version,
 * placeholders unrendered) and who wrote it, so the person can judge it before typing a sudo
 * password, then Open terminal / Run again / Cancel step.
 */
export function OperatorStepItem({
  step,
  runtimeName,
  nodeLabel,
  since,
  ready,
  busy,
  onAttach,
  onReopen,
  onCancel,
}: {
  step: OperatorStepView;
  runtimeName: string;
  nodeLabel: string;
  since: string;
  /** The terminal socket is up: a ticket may be taken now. */
  ready: boolean;
  /** A request for this step is in flight. */
  busy: boolean;
  onAttach: () => void;
  onReopen: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const waiting = step.state === "AWAITING_OPERATOR";
  const canAttach = step.terminalOpen && (waiting || step.state === "RUNNING");
  const canReopen = waiting && !step.terminalOpen;
  // A person's run in progress finishes in its terminal; it is never cancelled from here.
  const canCancel = waiting || step.state === "PENDING";
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words font-medium">{runtimeName}</span>
        <StatusPill tone="info">{t(`terminals:steps.phase.${step.phase}`)}</StatusPill>
        {step.commandAuthor ? (
          <StatusPill tone={step.commandAuthor === "user" ? "muted" : "busy"}>
            {t(`terminals:steps.author.${step.commandAuthor}`)}
          </StatusPill>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground" role="status">
        {t(operatorStepStatusKey(step))}
      </p>
      {step.command ? (
        <CodeSnippet code={step.command} copyLabel={t("terminals:copyCommand")} />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("terminals:onNode", { node: nodeLabel })} · {t("terminals:steps.since")}{" "}
        <TimeAgo value={since} />
      </p>
      {canAttach ? (
        <p className="text-xs text-muted-foreground">{t("terminals:steps.passwordNote")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canAttach ? (
          <Button type="button" size="touch" disabled={!ready || busy} onClick={onAttach}>
            {t("terminals:steps.attach")}
          </Button>
        ) : null}
        {canReopen ? (
          <Button type="button" size="touch" disabled={busy} onClick={onReopen}>
            {t("terminals:steps.reopen")}
          </Button>
        ) : null}
        {canCancel ? (
          <Button type="button" variant="ghost" size="touch" disabled={busy} onClick={onCancel}>
            {t("terminals:steps.cancel")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
