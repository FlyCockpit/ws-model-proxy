import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { SquareTerminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { OperatorStepItem } from "@/components/runtimes/operator-step-item";
import { TerminalPane } from "@/components/terminal-pane";
import { TimeAgo } from "@/components/time-ago";
import {
  type OpenTicketInput,
  type TerminalTab,
  useTerminalSessions,
} from "@/hooks/use-terminal-sessions";
import { refusalText } from "@/lib/refusal-text";
import type { CliTrust } from "@/lib/terminal-cli-identity";
import { typableCommand } from "@/lib/terminal-protocol";
import { TERMINAL_CHROME_VARS } from "@/lib/terminal-theme";
import { followSize, writerStatusKey } from "@/lib/terminal-writer";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/terminals")({
  component: TerminalsPage,
});

/** The size a terminal opens at before the browser pane fits it. */
const INITIAL_SIZE = { cols: 120, rows: 32 };

const APPROVAL_COMMAND_PREFIX = "wsmp terminal approve";

/** Refusal reasons with their own copy; anything else shows the generic line. */
const KNOWN_REJECTIONS: ReadonlySet<string> = new Set([
  "identity_changed",
  "identity_invalid",
  "identity_mismatch",
  "offline",
  "not_found",
  "not_granted",
  "unsupported",
  "cli_too_old",
  "limit",
  "invalid",
  "ticket_invalid",
  "bad_handshake",
  "step_detached",
]);

type Sessions = ReturnType<typeof useTerminalSessions>;
type OpenTerminal = (input: OpenTicketInput) => void;

function TerminalsPage() {
  const sessions = useTerminalSessions();
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const slugOf = (nodeId: string) => nodes.data?.nodes.find((node) => node.id === nodeId)?.slug;
  // A ticket is used up by its open: take one only once the socket and identity are ready, so
  // the open goes out at once (and a queued command is never decided for nothing).
  const ready = sessions.status === "open" && sessions.identityReady;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="terminals" />
      <TerminalWorkspace sessions={sessions} slugOf={slugOf} />
      <WaitingSteps sessions={sessions} ready={ready} slugOf={slugOf} />
      <QueuedCommands ready={ready} openTerminal={sessions.openTicket} slugOf={slugOf} />
      <TerminalNodes ready={ready} openTerminal={sessions.openTicket} />
    </div>
  );
}

function TerminalWorkspace({
  sessions,
  slugOf,
}: {
  sessions: Sessions;
  slugOf: (nodeId: string) => string | undefined;
}) {
  const { t } = useTranslation(["terminals", "dashboard"]);
  const { tabs, activeLocalId } = sessions;
  const active = tabs.find((tab) => tab.localId === activeLocalId) ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("terminals:workspaceTitle")}</CardTitle>
        <CardDescription>{t("terminals:workspaceDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {sessions.status !== "open" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t(`terminals:socket.${sessions.status}`)}
          </p>
        ) : null}
        {tabs.length === 0 ? (
          <p className="flex min-w-0 items-start gap-2 text-sm text-muted-foreground">
            <SquareTerminal aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">{t("terminals:workspaceEmpty")}</span>
          </p>
        ) : (
          <>
            <div
              role="tablist"
              aria-label={t("terminals:workspaceTitle")}
              className="flex min-w-0 max-w-full gap-2 overflow-x-auto overflow-y-hidden overscroll-x-contain"
            >
              {tabs.map((tab) => (
                <Button
                  key={tab.localId}
                  type="button"
                  role="tab"
                  aria-selected={tab.localId === activeLocalId}
                  variant={tab.localId === activeLocalId ? "secondary" : "ghost"}
                  size="touch"
                  className="shrink-0 font-mono"
                  onClick={() => sessions.selectTab(tab.localId)}
                >
                  <span>{slugOf(tab.cliDeviceId) ?? t("terminals:unknownNode")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t(`terminals:phase.${tab.phase}`)}
                  </span>
                </Button>
              ))}
            </div>
            {active ? <TabStatus sessions={sessions} tab={active} /> : null}
            <div
              style={TERMINAL_CHROME_VARS}
              className="relative h-[60svh] min-h-72 w-full min-w-0 overflow-hidden rounded-md bg-(--term-bg)"
            >
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.localId}
                  localId={tab.localId}
                  active={tab.localId === activeLocalId}
                  follow={followSize(tab)}
                  sendInput={sessions.sendInput}
                  sendResize={sessions.sendResize}
                  subscribeOutput={sessions.subscribeOutput}
                />
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TabStatus({ sessions, tab }: { sessions: Sessions; tab: TerminalTab }) {
  const { t } = useTranslation(["terminals", "dashboard"]);
  const ended = tab.phase === "exited" || tab.phase === "rejected";
  const writerKey = tab.phase === "live" ? writerStatusKey(tab.writer) : null;
  const trust: CliTrust | undefined = sessions.cliTrust[tab.cliDeviceId];
  const changed = tab.rejectionReason === "identity_changed" && trust?.status === "changed";
  const reason = tab.rejectionReason ?? tab.error;
  const rejection = !reason
    ? null
    : KNOWN_REJECTIONS.has(reason)
      ? t(`terminals:rejection.${reason}`)
      : t("terminals:rejection.other", { reason });
  const trustNewKey = async () => {
    if (trust?.status !== "changed") return;
    if (!(await sessions.trustNewKey(tab.cliDeviceId, trust))) {
      toast.error(t("terminals:trustFailed"));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-muted-foreground" role="status">
          {tab.phase === "exited"
            ? tab.exitCode !== null
              ? t("terminals:exitedWithCode", { code: tab.exitCode })
              : t("terminals:exitedPlain")
            : tab.phase === "rejected"
              ? rejection
              : tab.ending === "failed"
                ? t("terminals:endFailed")
                : [
                    writerKey ? t(writerKey) : null,
                    tab.viewerCount > 1
                      ? t("dashboard:terminals.status.viewers", { count: tab.viewerCount })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
        </p>
        <div className="flex flex-wrap gap-2">
          {/* An operator terminal ends with its command, or by its step's Cancel. */}
          {ended || tab.stepId ? null : (
            <Button
              type="button"
              variant="outline"
              size="touch"
              disabled={tab.ending === "pending"}
              onClick={() => sessions.endSession(tab.localId)}
            >
              {tab.ending === "pending" ? t("terminals:ending") : t("terminals:endSession")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label={ended ? t("terminals:closeTab") : t("terminals:detach")}
            title={ended ? t("terminals:closeTab") : t("terminals:detach")}
            onClick={() => sessions.detachTab(tab.localId)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
      {tab.approvalCode && tab.phase === "opening" ? (
        <p className="min-w-0 break-words">
          {t("terminals:approvalNeeded", {
            command: `${APPROVAL_COMMAND_PREFIX} ${tab.approvalCode}`,
          })}
        </p>
      ) : null}
      {changed ? (
        <div className="flex min-w-0 flex-col gap-2">
          <p className="min-w-0 break-words">
            {t("terminals:identityChangedDetail", { fingerprint: trust.fingerprint })}
          </p>
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={() => void trustNewKey()}
          >
            {t("terminals:trustNewKey")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TerminalNodes({ ready, openTerminal }: { ready: boolean; openTerminal: OpenTerminal }) {
  const { t } = useTranslation(["terminals"]);
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const openTicket = useMutation(
    orpc.nodes.terminals.openTicket.mutationOptions({
      onSuccess: (data, input) => openTerminal({ cliDeviceId: input.nodeId, ticket: data.ticket }),
      onError: (error) => toast.error(refusalText(error)),
    }),
  );
  const list = nodes.data?.nodes ?? [];
  const eligible = list.filter(
    (node) =>
      node.trust.effective === "FULL" && !node.trust.lowerPending && node.connection === "ONLINE",
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("terminals:nodesTitle")}</CardTitle>
        <CardDescription>{t("terminals:nodesDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        {nodes.isPending ? (
          <Skeleton aria-hidden="true" className="h-11 w-full" />
        ) : nodes.isError ? (
          <InlineRetry message={t("terminals:nodesUnavailable")} onRetry={() => nodes.refetch()} />
        ) : list.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("terminals:noNodes")}</p>
        ) : (
          <>
            {eligible.length === 0 ? (
              <p className="pb-2 text-sm text-muted-foreground">{t("terminals:noFullNodes")}</p>
            ) : null}
            {list.map((node) => {
              const full = node.trust.effective === "FULL" && !node.trust.lowerPending;
              const online = node.connection === "ONLINE";
              return (
                <div
                  key={node.id}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-mono text-sm">{node.name ?? node.slug}</p>
                    {!full || !online ? (
                      <p className="text-xs text-muted-foreground">
                        {!full ? t("terminals:relayOnly") : t("terminals:offline")}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    disabled={!ready || !full || !online || openTicket.isPending}
                    onClick={() => openTicket.mutate({ nodeId: node.id, ...INITIAL_SIZE })}
                  >
                    {openTicket.isPending && openTicket.variables?.nodeId === node.id
                      ? t("terminals:opening")
                      : t("terminals:open")}
                  </Button>
                </div>
              );
            })}
          </>
        )}
      </CardContent>
    </Card>
  );
}

type NeedsYouItem = Awaited<
  ReturnType<AppRouterClient["activity"]["needsYou"]["list"]>
>["items"][number];

/** `runtimes.steps.*` refusals with their own copy (the error's `data.code`). */
const STEP_REFUSALS: ReadonlySet<string> = new Set([
  "not_interactive",
  "not_waiting",
  "running",
  "superseded",
  "terminal_closed",
  "terminal_unavailable",
]);

function stepRefusalText(error: unknown, t: (key: string) => string): string {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? (error as { data: unknown }).data
      : null;
  const code =
    typeof data === "object" && data !== null && "code" in data
      ? (data as { code: unknown }).code
      : null;
  return typeof code === "string" && STEP_REFUSALS.has(code)
    ? t(`terminals:steps.refusal.${code}`)
    : refusalText(error);
}

/**
 * Interactive runtime steps waiting for their person (also on Relay-only nodes): Open terminal
 * attaches to the operator terminal the node opened for the step; Run again opens a fresh one
 * after it closed; Cancel step gives up on it.
 */
function WaitingSteps({
  sessions,
  ready,
  slugOf,
}: {
  sessions: Sessions;
  ready: boolean;
  slugOf: (nodeId: string) => string | undefined;
}) {
  const { t } = useTranslation(["terminals"]);
  const needs = useQuery({
    ...orpc.activity.needsYou.list.queryOptions(),
    refetchInterval: STEP_REFRESH_MS,
  });
  const items = (needs.data?.items ?? []).filter(
    (item): item is NeedsYouItem & { stepId: string } =>
      item.need === "STEP" && item.stepId !== null,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("terminals:steps.title")}</CardTitle>
        <CardDescription>{t("terminals:steps.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        {needs.isPending ? (
          <Skeleton aria-hidden="true" className="h-24 w-full" />
        ) : needs.isError ? (
          <InlineRetry message={t("terminals:steps.loadFailed")} onRetry={() => needs.refetch()} />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("terminals:steps.empty")}</p>
        ) : (
          items.map((item) => (
            <WaitingStep
              key={item.stepId}
              item={item}
              sessions={sessions}
              ready={ready}
              slugOf={slugOf}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

const STEP_REFRESH_MS = 5_000;

function WaitingStep({
  item,
  sessions,
  ready,
  slugOf,
}: {
  item: NeedsYouItem & { stepId: string };
  sessions: Sessions;
  ready: boolean;
  slugOf: (nodeId: string) => string | undefined;
}) {
  const { t } = useTranslation(["terminals"]);
  const queryClient = useQueryClient();
  const runtime = useQuery({
    ...orpc.runtimes.get.queryOptions({ input: { runtimeId: item.runtimeId } }),
    refetchInterval: STEP_REFRESH_MS,
  });
  const instance = runtime.data?.instanceList.find((row) => row.id === item.instanceId);
  const step = instance?.openSteps.find((row) => row.id === item.stepId);
  // The node of the step's rank: the node whose identity the attach handshake checks.
  const nodeId = step
    ? (instance?.ranks.find((rank) => rank.nodeNumber === step.nodeNumber)?.nodeId ?? null)
    : null;
  // This page already views the step's terminal: Open terminal shows that tab.
  const openTab = sessions.tabs.find(
    (tab) => tab.stepId === item.stepId && tab.phase !== "exited" && tab.phase !== "rejected",
  );
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.list.key() }),
      queryClient.invalidateQueries({
        queryKey: orpc.runtimes.get.key({ input: { runtimeId: item.runtimeId } }),
      }),
    ]);
  };
  const attach = useMutation(
    orpc.runtimes.steps.attach.mutationOptions({
      onSuccess: (data) => {
        if (nodeId)
          sessions.openTicket({ cliDeviceId: nodeId, ticket: data.ticket, stepId: item.stepId });
      },
      onError: (error) => toast.error(stepRefusalText(error, t)),
      onSettled: invalidate,
    }),
  );
  const reopen = useMutation(
    orpc.runtimes.steps.reopen.mutationOptions({
      onSuccess: () => toast.success(t("terminals:steps.reopened")),
      onError: (error) => toast.error(stepRefusalText(error, t)),
      onSettled: invalidate,
    }),
  );
  const cancel = useMutation(
    orpc.runtimes.steps.cancel.mutationOptions({
      onSuccess: () => toast.success(t("terminals:steps.cancelled")),
      onError: (error) => toast.error(stepRefusalText(error, t)),
      onSettled: invalidate,
    }),
  );
  if (runtime.isPending) return <Skeleton aria-hidden="true" className="my-3 h-24 w-full" />;
  if (runtime.isError)
    return (
      <InlineRetry message={t("terminals:steps.loadFailed")} onRetry={() => runtime.refetch()} />
    );
  // The step moved on since the list was read; the next refresh drops it.
  if (!step) return null;
  return (
    <OperatorStepItem
      step={step}
      runtimeName={item.runtimeName}
      nodeLabel={(nodeId ? slugOf(nodeId) : undefined) ?? t("terminals:unknownNode")}
      since={item.since}
      ready={ready && nodeId !== null}
      busy={attach.isPending || reopen.isPending || cancel.isPending}
      onAttach={() => {
        if (openTab) sessions.selectTab(openTab.localId);
        else attach.mutate({ stepId: step.id, ...INITIAL_SIZE });
      }}
      onReopen={() => reopen.mutate({ stepId: step.id })}
      onCancel={() => cancel.mutate({ stepId: step.id })}
    />
  );
}

function QueuedCommands({
  ready,
  openTerminal,
  slugOf,
}: {
  ready: boolean;
  openTerminal: OpenTerminal;
  slugOf: (nodeId: string) => string | undefined;
}) {
  const { t } = useTranslation(["terminals"]);
  const queryClient = useQueryClient();
  const queued = useQuery(orpc.nodes.queued.list.queryOptions({ input: { state: "QUEUED" } }));
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.nodes.queued.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.list.key() }),
    ]);
  };
  const run = useMutation(
    orpc.nodes.queued.run.mutationOptions({
      onSuccess: (data) => {
        const typed = typableCommand(data.item.command);
        // Typed without a newline once the shell is up: the person reads it and presses Enter.
        openTerminal({
          cliDeviceId: data.item.nodeId,
          ticket: data.ticket,
          ...(typed ? { typedCommand: data.item.command } : {}),
        });
        if (typed) toast.info(t("terminals:typedCommandHint"));
        else toast.warning(t("terminals:typedCommandNotTyped"));
      },
      onError: (error) => toast.error(refusalText(error)),
      onSettled: invalidate,
    }),
  );
  const dismiss = useMutation(
    orpc.nodes.queued.dismiss.mutationOptions({
      onSuccess: () => toast.success(t("terminals:dismissed")),
      onError: (error) => toast.error(refusalText(error)),
      onSettled: invalidate,
    }),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("terminals:queuedTitle")}</CardTitle>
        <CardDescription>{t("terminals:queuedDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        {queued.isPending ? (
          <Skeleton aria-hidden="true" className="h-24 w-full" />
        ) : queued.isError ? (
          <InlineRetry message={t("terminals:queuedLoadFailed")} onRetry={() => queued.refetch()} />
        ) : queued.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("terminals:queuedEmpty")}</p>
        ) : (
          queued.data.items.map((item) => (
            <div key={item.id} className="flex min-w-0 flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <CodeSnippet code={item.command} copyLabel={t("terminals:copyCommand")} />
              {item.note ? <p className="text-sm">{item.note}</p> : null}
              <p className="text-xs text-muted-foreground">
                {t("terminals:onNode", { node: slugOf(item.nodeId) ?? t("terminals:unknownNode") })}{" "}
                · {t("terminals:fromAgent")} · {t("terminals:expires")}{" "}
                <TimeAgo value={item.expiresAt} />
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="touch"
                  disabled={!ready || run.isPending}
                  onClick={() => run.mutate({ queuedCommandId: item.id, ...INITIAL_SIZE })}
                >
                  {t("terminals:run")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="touch"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate({ queuedCommandId: item.id })}
                >
                  {t("terminals:dismiss")}
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
