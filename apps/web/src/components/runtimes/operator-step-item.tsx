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
 * The command the person authorizes: rendered with the values its job sends, as the node renders
 * it (`rendered`). Values only the node knows stay `{{name}}` with a note. When the server cannot
 * render it faithfully, or the node would refuse it, it says so and shows only the template.
 */
function StepCommand({ step }: { step: OperatorStepView }) {
  const { t } = useTranslation(["terminals"]);
  const copyLabel = t("terminals:copyCommand");
  const rendered = step.rendered;
  if (!rendered)
    return step.command ? <CodeSnippet code={step.command} copyLabel={copyLabel} /> : null;
  const template = step.command ? (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs text-muted-foreground">{t("terminals:steps.template")}</p>
      <CodeSnippet code={step.command} copyLabel={copyLabel} />
    </div>
  ) : null;
  if (rendered.state === "ready")
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">{t("terminals:steps.commandRendered")}</p>
        <CodeSnippet code={rendered.text} copyLabel={copyLabel} />
        {step.headAddr ? (
          <p className="break-all text-xs text-muted-foreground">
            {t("terminals:steps.headAddr", { addr: step.headAddr })}
          </p>
        ) : null}
        {rendered.nodeFills.length > 0 ? (
          <p className="text-xs text-muted-foreground" role="note">
            {t("terminals:steps.nodeFills", {
              names: rendered.nodeFills.map((name) => `{{${name}}}`).join(", "),
            })}
          </p>
        ) : null}
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm text-destructive" role="alert">
        {rendered.state === "refused"
          ? // An open terminal means the node accepted the job: the prediction was wrong.
            step.terminalOpen
            ? `${t("terminals:steps.refusedButOpen", { field: rendered.field })} ${t("terminals:steps.unavailableHint")}`
            : t("terminals:steps.refused", { field: rendered.field })
          : `${t(`terminals:steps.unavailable.${rendered.reason}`)} ${t("terminals:steps.unavailableHint")}`}
      </p>
      {template}
    </div>
  );
}

/**
 * One interactive step waiting for its person: the command with its values filled in as the node
 * renders it, and who wrote it, so the person can judge it before typing a sudo password, then
 * Open terminal / Run again / Cancel step.
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
      <StepCommand step={step} />
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
