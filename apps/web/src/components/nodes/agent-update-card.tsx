import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { TFunction } from "i18next";
import { Check, CircleAlert, Download, Info, Loader2, Undo2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { TimeAgo } from "@/components/time-ago";
import { useAgentUpdateOverview } from "@/hooks/use-agent-update-overview";
import {
  AGENT_UPDATE_NODE_REASONS,
  forceOffered,
  INSTALL_METHODS,
  isTerminalPhase,
  knownOr,
  nodeUpdateMode,
  progressSteps,
  STUCK_PHASES,
  shortCommit,
} from "@/lib/agent-update";
import { orpc } from "@/utils/orpc";

import { CommandBlock, StatusPill } from "./node-badges";
import type {
  AgentUpdateOverview,
  AgentUpdatePolicy,
  AgentUpdateView,
  NodeAgentUpdateView,
} from "./node-types";
import { refusalKeys, refusalToastOptions } from "./refusal";

const K = "dashboard:nodes.agentUpdate";
const POLICIES: readonly AgentUpdatePolicy[] = ["ALLOWED", "OFF"];

/** Copy for a refusal code the server puts in `blockedReason` (or a generic line). */
function blockedReasonText(t: TFunction, reason: string | null): string {
  if (!reason) return t(`${K}.blocked.generic`);
  return t([...refusalKeys(reason), `${K}.blocked.generic`]);
}

/** Copy for the reason a node gave with `refused` or `failed`. */
function nodeReasonText(t: TFunction, reason: string | null): string | null {
  if (!reason) return null;
  return t(`${K}.reason.${knownOr(AGENT_UPDATE_NODE_REASONS, reason, "other")}`);
}

function isHomebrew(view: NodeAgentUpdateView): boolean {
  return (
    view.build?.installMethod === "homebrew" ||
    (view.selfUpdate?.strategies.includes("homebrew") ?? false)
  );
}

/** The node's wsmp: version and build, the update action, progress and the policy setting. */
export function AgentUpdateCard({ nodeId }: { nodeId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const overview = useAgentUpdateOverview();
  if (overview.isPending) return <AgentUpdateCardSkeleton />;
  if (overview.isError)
    return (
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-base">{t(`${K}.title`)}</CardTitle>
        </CardHeader>
        <CardContent>
          <InlineRetry message={t(`${K}.loadFailed`)} onRetry={() => overview.refetch()} />
        </CardContent>
      </Card>
    );
  const view = overview.data.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!view) return null;
  return <AgentUpdatePanel server={overview.data.server} view={view} />;
}

export function AgentUpdatePanel({
  server,
  view,
}: {
  server: AgentUpdateOverview["server"];
  view: NodeAgentUpdateView;
}) {
  const { t } = useTranslation(["dashboard"]);
  const commit = shortCommit(view.build?.commit);
  const serverCommit = shortCommit(server.commit);
  const method = view.build
    ? t(`${K}.method.${knownOr(INSTALL_METHODS, view.build.installMethod, "unknown")}`)
    : null;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t(`${K}.title`)}
          {view.version === null ? null : view.outdated ? (
            <StatusPill tone="warning">{t(`${K}.outdated`)}</StatusPill>
          ) : (
            <StatusPill tone="success">{t(`${K}.current`)}</StatusPill>
          )}
          {view.wsl ? <StatusPill tone="muted">{t(`${K}.wslBadge`)}</StatusPill> : null}
        </CardTitle>
        <CardDescription>{t(`${K}.description`)}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 space-y-4 text-sm">
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t(`${K}.nodeVersion`)}</dt>
          <dd className="min-w-0 break-words">
            {view.version ? (
              <span className="font-mono">{view.version}</span>
            ) : (
              t(`${K}.unknownVersion`)
            )}
          </dd>
          <dt className="text-muted-foreground">{t(`${K}.build`)}</dt>
          <dd className="min-w-0 break-words">
            {commit ? <span className="font-mono">{commit}</span> : t(`${K}.unknownCommit`)}
            {method ? ` · ${method}` : null}
          </dd>
          <dt className="text-muted-foreground">{t(`${K}.serverVersion`)}</dt>
          <dd className="min-w-0 break-words">
            <span className="font-mono">{server.version}</span>
            {serverCommit ? <span className="font-mono"> · {serverCommit}</span> : null}
          </dd>
        </dl>

        {view.wsl ? <Notice tone="warning">{t(`${K}.wslWarning`)}</Notice> : null}

        {view.latest ? <LatestUpdate view={view} latest={view.latest} /> : null}

        <UpdateActions view={view} />

        <PolicySetting view={view} />
      </CardContent>
    </Card>
  );
}

function Notice({
  tone,
  children,
}: {
  tone: "info" | "warning" | "destructive" | "success";
  children: React.ReactNode;
}) {
  const Icon =
    tone === "success" ? Check : tone === "warning" || tone === "destructive" ? CircleAlert : Info;
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-md border p-3",
        tone === "warning" && "border-state-warning/40 bg-state-warning/10",
        tone === "destructive" && "border-destructive/30 bg-destructive/5",
        tone === "success" && "border-state-success/40 bg-state-success/10",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "destructive" ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

/** Text a node sent (log tail, command): plain text in a bounded, scrollable block. */
function NodeText({ text, label }: { text: string; label: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <pre
        aria-label={label}
        className="max-h-48 min-w-0 overflow-x-auto overflow-y-auto overscroll-contain rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all"
      >
        {text}
      </pre>
    </div>
  );
}

function LatestUpdate({ view, latest }: { view: NodeAgentUpdateView; latest: AgentUpdateView }) {
  const { t } = useTranslation(["dashboard"]);
  const values = {
    from: latest.fromVersion ?? t(`${K}.unknownVersion`),
    to: latest.toVersion,
  };
  const reason = nodeReasonText(t, latest.reason);
  const detail = latest.detail ? (
    <NodeText text={latest.detail} label={t(`${K}.nodeSaid`)} />
  ) : null;
  // The server sets it when the node cannot update itself, or to recover a Homebrew failure.
  const recovery = view.manualCommand;
  const recoveryBlock = recovery ? (
    <div className="min-w-0 space-y-1.5">
      <p>{t(`${K}.fixByHand`)}</p>
      <CommandBlock command={recovery} label={t(`${K}.manualCommand`)} />
    </div>
  ) : null;

  if (!isTerminalPhase(latest.phase)) return <UpdateProgress view={view} latest={latest} />;

  switch (latest.phase) {
    case "confirmed":
      return (
        <Notice tone="success">
          <p>
            {t(`${K}.confirmed`, values)}{" "}
            {latest.endedAt ? (
              <span className="text-muted-foreground">
                <TimeAgo value={latest.endedAt} />
              </span>
            ) : null}
          </p>
        </Notice>
      );
    case "rolled_back":
      return (
        <Notice tone="warning">
          <p className="flex items-center gap-1.5 font-medium">
            <Undo2 aria-hidden="true" className="size-4 shrink-0" />
            {t(`${K}.rolledBackTitle`)}
          </p>
          <p>{t(`${K}.rolledBack`, values)}</p>
          {detail}
        </Notice>
      );
    case "refused":
      return (
        <Notice tone="destructive">
          <p className="font-medium">{t(`${K}.refusedTitle`, values)}</p>
          {reason ? <p>{reason}</p> : null}
          {detail}
          {recoveryBlock}
        </Notice>
      );
    case "timed_out":
      return (
        <Notice tone="destructive">
          <p className="font-medium">
            {t(`${K}.timedOutTitle`, {
              ...values,
              phase: t(`${K}.stuck.${knownOr(STUCK_PHASES, latest.reason, "other")}`),
            })}
          </p>
          <p>{isHomebrew(view) ? t(`${K}.timedOutHomebrew`) : t(`${K}.timedOut`)}</p>
          {detail}
          {recoveryBlock}
        </Notice>
      );
    default:
      return (
        <Notice tone="destructive">
          <p className="font-medium">{t(`${K}.failedTitle`, values)}</p>
          {reason ? <p>{reason}</p> : null}
          {detail}
          {recoveryBlock}
        </Notice>
      );
  }
}

function UpdateProgress({ view, latest }: { view: NodeAgentUpdateView; latest: AgentUpdateView }) {
  const { t } = useTranslation(["dashboard"]);
  const steps = progressSteps(latest.phase, isHomebrew(view));
  return (
    <section className="min-w-0 space-y-2" aria-live="polite">
      <h3 className="font-medium">
        {t(`${K}.updatingTo`, {
          from: latest.fromVersion ?? t(`${K}.unknownVersion`),
          to: latest.toVersion,
        })}
      </h3>
      <ol className="space-y-1">
        {steps.map((step) => (
          <li
            key={step.phase}
            aria-current={step.state === "current" ? "step" : undefined}
            className={cn(
              "flex min-w-0 items-center gap-2",
              step.state === "upcoming" && "text-muted-foreground",
              step.state === "current" && "font-medium",
            )}
          >
            {step.state === "done" ? (
              <Check aria-hidden="true" className="size-4 shrink-0 text-state-success" />
            ) : step.state === "current" ? (
              <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            ) : (
              <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center">
                <span className="size-1.5 rounded-full bg-muted-foreground" />
              </span>
            )}
            <span className="min-w-0">{t(`${K}.step.${step.phase}`)}</span>
          </li>
        ))}
      </ol>
      {latest.phase === "waiting_idle" ? (
        <>
          <p className="text-muted-foreground">
            {t(`${K}.waitingIdle`, { count: view.runningInstances.length })}
          </p>
          {forceOffered(view) ? <ForceUpdateButton view={view} /> : null}
        </>
      ) : null}
      {latest.force ? <p className="text-muted-foreground">{t(`${K}.forced`)}</p> : null}
    </section>
  );
}

/** `nodes.agentUpdate.start`; `onStarted` runs after a successful start (closes a dialog). */
function useStartUpdate(onStarted?: () => void) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.nodes.agentUpdate.start.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${K}.started`));
        onStarted?.();
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
}

/**
 * "Stop instances and update now" with its confirmation. On a node waiting for idle, a forced
 * start forces that same update (the server resends it forced).
 */
function ForceUpdateButton({ view }: { view: NodeAgentUpdateView }) {
  const { t } = useTranslation(["dashboard"]);
  const [forcing, setForcing] = useState(false);
  const start = useStartUpdate(() => setForcing(false));
  return (
    <>
      <Button
        variant="outline"
        className="min-h-[44px]"
        disabled={start.isPending}
        onClick={() => setForcing(true)}
      >
        {t(`${K}.updateNow`)}
      </Button>
      <ForceUpdateDialog
        view={view}
        open={forcing}
        onOpenChange={setForcing}
        pending={start.isPending}
        onConfirm={() => start.mutate({ nodeId: view.nodeId, force: true })}
      />
    </>
  );
}

function UpdateActions({ view }: { view: NodeAgentUpdateView }) {
  const { t } = useTranslation(["dashboard"]);
  const start = useStartUpdate();
  const mode = nodeUpdateMode(view);
  const command = view.manualCommand ? (
    <CommandBlock command={view.manualCommand} label={t(`${K}.manualCommand`)} />
  ) : null;

  switch (mode) {
    case "in_flight":
    case "current":
      return null;
    case "too_old":
      return (
        <div className="min-w-0 space-y-1.5">
          <p>{t(`${K}.tooOld`)}</p>
          {command}
        </div>
      );
    case "manual":
      return (
        <div className="min-w-0 space-y-1.5">
          <p className="font-medium">{t(`${K}.runOnNode`)}</p>
          <p className="text-muted-foreground">
            {view.build?.installMethod === "source" ? t(`${K}.sourceBuild`) : t(`${K}.noStrategy`)}
          </p>
          {command}
        </div>
      );
    case "blocked":
      return (
        <div className="min-w-0 space-y-1.5">
          <p>{blockedReasonText(t, view.blockedReason)}</p>
          {view.selfUpdate?.remote === "off" ? (
            <p className="text-muted-foreground">{t(`${K}.remoteOff`)}</p>
          ) : null}
          {command}
        </div>
      );
    case "ready": {
      const force = forceOffered(view);
      return (
        <div className="min-w-0 space-y-2">
          {force ? (
            <p className="text-muted-foreground">
              {t(`${K}.waitsForIdle`, { count: view.runningInstances.length })}
            </p>
          ) : view.runningInstances.length > 0 ? (
            <p className="text-muted-foreground">{t(`${K}.instancesKeepRunning`)}</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-[44px]"
              disabled={start.isPending}
              onClick={() => start.mutate({ nodeId: view.nodeId })}
            >
              <Download aria-hidden="true" />
              {force ? t(`${K}.updateWhenIdle`) : t(`${K}.update`)}
            </Button>
            {force ? <ForceUpdateButton view={view} /> : null}
          </div>
        </div>
      );
    }
  }
}

function ForceUpdateDialog({
  view,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  view: NodeAgentUpdateView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const count = view.runningInstances.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(`${K}.forceTitle`, { count, slug: view.slug })}</DialogTitle>
          <DialogDescription>{t(`${K}.forceDescription`)}</DialogDescription>
        </DialogHeader>
        <section className="min-w-0 space-y-1 text-sm">
          <h3 className="font-medium">{t(`${K}.forceStops`, { count })}</h3>
          <ul className="list-disc space-y-0.5 pl-5">
            {view.runningInstances.map((instance) => (
              <li key={instance.id} className="break-words">
                {instance.name}
              </li>
            ))}
          </ul>
        </section>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="min-h-[44px]"
            onClick={() => onOpenChange(false)}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="destructive"
            className="min-h-[44px]"
            disabled={pending}
            onClick={onConfirm}
          >
            {t(`${K}.forceConfirm`, { count })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PolicySetting({ view }: { view: NodeAgentUpdateView }) {
  const { t } = useTranslation(["dashboard"]);
  const name = useId();
  const queryClient = useQueryClient();
  const setPolicy = useMutation({
    ...orpc.nodes.agentUpdate.setPolicy.mutationOptions({
      onSuccess: () => {
        toast.success(t(`${K}.policy.saved`));
        queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
  const shown =
    setPolicy.isPending && setPolicy.variables ? setPolicy.variables.policy : view.policy;
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 border-t pt-4">
      <legend className="float-left mb-2 w-full font-medium">{t(`${K}.policy.label`)}</legend>
      {POLICIES.map((policy) => (
        <label
          key={policy}
          className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md border p-3 has-[:checked]:border-primary has-[:disabled]:cursor-not-allowed"
        >
          <input
            type="radio"
            name={name}
            value={policy}
            checked={shown === policy}
            disabled={setPolicy.isPending}
            onChange={() => setPolicy.mutate({ nodeId: view.nodeId, policy })}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{t(`${K}.policy.options.${policy}`)}</span>
            <span className="block text-xs text-muted-foreground">
              {t(`${K}.policy.help.${policy}`)}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function AgentUpdateCardSkeleton() {
  return (
    <Card aria-hidden="true" className="min-w-0">
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-11 w-32" />
        <div className="space-y-2 border-t pt-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}
