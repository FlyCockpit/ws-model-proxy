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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Maximize2, Minimize2, Settings2, TextSelect, X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { OperatorStepItem } from "@/components/runtimes/operator-step-item";
import { TerminalNodeRow } from "@/components/terminal-node-row";
import { TerminalPane } from "@/components/terminal-pane";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import { useHideAppChrome } from "@/hooks/use-hide-app-chrome";
import {
  type OpenTicketInput,
  type TerminalTab,
  useTerminalSessions,
} from "@/hooks/use-terminal-sessions";
import { refusalText } from "@/lib/refusal-text";
import type { CliTrust } from "@/lib/terminal-cli-identity";
import { typableCommand } from "@/lib/terminal-protocol";
import {
  isTerminalCopyMode,
  isTerminalShiftEnterMode,
  TERMINAL_COPY_MODES,
  TERMINAL_SHIFT_ENTER_MODES,
} from "@/lib/terminal-settings";
import { TERMINAL_CHROME_VARS } from "@/lib/terminal-theme";
import { followSize, writerStatusKey } from "@/lib/terminal-writer";
import { useUiPreferences } from "@/stores/ui-preferences";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/terminals")({
  component: TerminalsPage,
});

/** The size a terminal opens at before the browser pane fits it. */
const INITIAL_SIZE = { cols: 120, rows: 32 };

/** Recently closed queued commands listed under the waiting ones. */
const RECENTLY_CLOSED_SHOWN = 10;

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

/** How often the node list refreshes, so a node going offline or coming back shows without a reload. */
const NODES_REFRESH_MS = 5_000;

type Sessions = ReturnType<typeof useTerminalSessions>;
type OpenTerminal = (input: OpenTicketInput) => void;

function TerminalsPage() {
  const { t } = useTranslation(["terminals"]);
  const sessions = useTerminalSessions();
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), refetchInterval: NODES_REFRESH_MS });
  const slugOf = (nodeId: string) => nodes.data?.nodes.find((node) => node.id === nodeId)?.slug;
  // A ticket is used up by its open: take one only once the socket and identity are ready, so
  // the open goes out at once (and a queued command is never decided for nothing).
  const ready = sessions.status === "open" && sessions.identityReady;
  const hasTabs = sessions.tabs.length > 0;
  // Maximize applies only while there is a terminal to show.
  const maximized = useUiPreferences((prefs) => prefs.terminalMaximized) && hasTabs;
  // Maximized, the terminal takes the whole viewport: the app's header, navigation and sidebar
  // step aside (the tabs and toolbar stay, so tabs switch and maximize turns off from here).
  useHideAppChrome(maximized);
  // One tree for both layouts: the workspace keeps its element position, so toggling maximize
  // never remounts the xterms (a new xterm starts empty; output already shown is not replayed).
  // The first section is the visible page height the app frame provides (--app-page-height):
  // flex gives the terminal whatever the heading and card chrome leave, however tall they wrap.
  // Restored, the sections below follow it and the page scrolls; maximized, it is the page.
  // With no terminal open there is no workspace: the heading alone, and the sections below
  // follow it directly.
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* No minimum height: when the keyboard leaves little room the terminal shrinks with it
          (the 20x5 terminal floor still applies) instead of reaching below the visible area.
          The section is a size container: when it is short (a phone with the keyboard open, a
          landscape phone), the heading and the card's description give their space to the
          terminal. Tabs, status and controls always stay. */}
      <div
        className={cn(
          "flex min-w-0 flex-col gap-6",
          hasTabs && "h-(--app-page-height) [container-type:size]",
        )}
      >
        {maximized ? null : (
          <div className={cn(hasTabs && SHORT_SECTION_HIDDEN)}>
            <PageHeading page="terminals" />
          </div>
        )}
        {hasTabs ? (
          <TerminalWorkspace sessions={sessions} slugOf={slugOf} maximized={maximized} />
        ) : sessions.status !== "open" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t(`terminals:socket.${sessions.status}`)}
          </p>
        ) : null}
      </div>
      {maximized ? null : (
        <>
          <WaitingSteps sessions={sessions} ready={ready} slugOf={slugOf} />
          <QueuedCommands ready={ready} openTerminal={sessions.openTicket} slugOf={slugOf} />
          <TerminalNodes ready={ready} openTerminal={sessions.openTicket} />
        </>
      )}
    </div>
  );
}

/** Hidden when the terminal section is short (see the section's container). */
const SHORT_SECTION_HIDDEN = "[@container(max-height:32rem)]:hidden";

const tabIdOf = (localId: string) => `terminal-tab-${localId}`;
const panelIdOf = (localId: string) => `terminal-panel-${localId}`;

function TerminalWorkspace({
  sessions,
  slugOf,
  maximized,
}: {
  sessions: Sessions;
  slugOf: (nodeId: string) => string | undefined;
  maximized: boolean;
}) {
  const { t } = useTranslation(["terminals", "dashboard"]);
  const { tabs, activeLocalId } = sessions;
  const active = tabs.find((tab) => tab.localId === activeLocalId) ?? null;
  // Select text is the session hook's: it pauses that tab's input, and switching or closing tabs
  // ends it there.
  const selecting = active !== null && sessions.selectingLocalId === active.localId;
  const [focusRequest, setFocusRequest] = useState(0);
  // Arrow keys, Home and End move between tabs (the tabs pattern); focus stays on the tab list.
  const onTabKeyDown = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    sessions.selectTab(tab.localId);
    document.getElementById(tabIdOf(tab.localId))?.focus();
  };
  return (
    <Card className={cn("min-h-0 flex-1", maximized && "rounded-none py-2 ring-0")}>
      {maximized ? null : (
        <CardHeader className={SHORT_SECTION_HIDDEN}>
          <CardTitle className="text-base">{t("terminals:workspaceTitle")}</CardTitle>
          <CardDescription>{t("terminals:workspaceDescription")}</CardDescription>
        </CardHeader>
      )}
      <CardContent
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-3", maximized && "gap-2 px-2")}
      >
        {sessions.status !== "open" ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t(`terminals:socket.${sessions.status}`)}
          </p>
        ) : null}
        {tabs.length === 0 ? null : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <WideContent
                role="tablist"
                aria-label={t("terminals:workspaceTitle")}
                className="flex flex-1 gap-2"
              >
                {tabs.map((tab, index) => (
                  <Button
                    key={tab.localId}
                    id={tabIdOf(tab.localId)}
                    type="button"
                    role="tab"
                    aria-selected={tab.localId === activeLocalId}
                    aria-controls={panelIdOf(tab.localId)}
                    tabIndex={tab.localId === activeLocalId ? 0 : -1}
                    variant={tab.localId === activeLocalId ? "secondary" : "ghost"}
                    size="touch"
                    className="shrink-0 font-mono"
                    // Mouse down does not move focus to the tab; the click decides where it goes.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      sessions.selectTab(tab.localId);
                      // A pointer click (detail > 0) hands focus to the terminal, even on the
                      // tab that is already active; keyboard activation keeps it on the tabs.
                      if (event.detail > 0) setFocusRequest((count) => count + 1);
                    }}
                    onKeyDown={(event) => onTabKeyDown(event, index)}
                  >
                    <span>{slugOf(tab.cliDeviceId) ?? t("terminals:unknownNode")}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(`terminals:phase.${tab.phase}`)}
                    </span>
                  </Button>
                ))}
              </WideContent>
              <TerminalToolbar
                maximized={maximized}
                selecting={selecting}
                canSelect={active !== null}
                onToggleSelecting={() =>
                  sessions.setSelecting(selecting ? null : (active?.localId ?? null))
                }
              />
            </div>
            {active ? <TabStatus sessions={sessions} tab={active} /> : null}
            <div
              style={TERMINAL_CHROME_VARS}
              className="relative min-h-0 w-full min-w-0 flex-1 overflow-hidden rounded-md bg-(--term-bg)"
            >
              {tabs.map((tab) => (
                <TerminalPane
                  key={tab.localId}
                  localId={tab.localId}
                  tabId={tabIdOf(tab.localId)}
                  panelId={panelIdOf(tab.localId)}
                  active={tab.localId === activeLocalId}
                  follow={followSize(tab)}
                  selecting={selecting && tab.localId === activeLocalId}
                  onDoneSelecting={() => sessions.setSelecting(null)}
                  sendInput={sessions.sendInput}
                  uploadImage={sessions.uploadImage}
                  pasteImage={sessions.pasteImage}
                  sendResize={sessions.sendResize}
                  sizeUnavailable={sessions.sizeUnavailable}
                  focusRequest={focusRequest}
                  currentSession={sessions.currentSession}
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

/** Maximize, Select text, and the terminal settings menu, beside the tabs. */
function TerminalToolbar({
  maximized,
  selecting,
  canSelect,
  onToggleSelecting,
}: {
  maximized: boolean;
  selecting: boolean;
  canSelect: boolean;
  onToggleSelecting: () => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const setMaximized = useUiPreferences((prefs) => prefs.setTerminalMaximized);
  const maximizeLabel = maximized
    ? t("terminals:toolbar.restore")
    : t("terminals:toolbar.maximize");
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        type="button"
        variant={selecting ? "secondary" : "ghost"}
        size="icon-touch"
        aria-pressed={selecting}
        aria-label={t("terminals:toolbar.selectText")}
        title={t("terminals:toolbar.selectText")}
        disabled={!canSelect}
        onClick={onToggleSelecting}
      >
        <TextSelect aria-hidden="true" />
      </Button>
      <TerminalSettingsMenu />
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        aria-pressed={maximized}
        aria-label={maximizeLabel}
        title={maximizeLabel}
        onClick={() => setMaximized(!maximized)}
      >
        {maximized ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </Button>
    </div>
  );
}

function TerminalSettingsMenu() {
  const { t } = useTranslation(["terminals"]);
  const copyMode = useUiPreferences((prefs) => prefs.terminalCopy);
  const setCopyMode = useUiPreferences((prefs) => prefs.setTerminalCopy);
  const shiftEnter = useUiPreferences((prefs) => prefs.terminalShiftEnter);
  const setShiftEnter = useUiPreferences((prefs) => prefs.setTerminalShiftEnter);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-touch"
            aria-label={t("terminals:toolbar.settings")}
            title={t("terminals:toolbar.settings")}
          />
        }
      >
        <Settings2 aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuRadioGroup
          value={copyMode}
          onValueChange={(value) => {
            if (isTerminalCopyMode(value)) setCopyMode(value);
          }}
        >
          <DropdownMenuLabel>{t("terminals:settings.copy.label")}</DropdownMenuLabel>
          {TERMINAL_COPY_MODES.map((mode) => (
            <SettingsRadioItem
              key={mode}
              value={mode}
              title={t(`terminals:settings.copy.${mode}.title`)}
              help={t(`terminals:settings.copy.${mode}.help`)}
            />
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={shiftEnter}
          onValueChange={(value) => {
            if (isTerminalShiftEnterMode(value)) setShiftEnter(value);
          }}
        >
          <DropdownMenuLabel>{t("terminals:settings.shiftEnter.label")}</DropdownMenuLabel>
          {TERMINAL_SHIFT_ENTER_MODES.map((mode) => (
            <SettingsRadioItem
              key={mode}
              value={mode}
              title={t(`terminals:settings.shiftEnter.${mode}.title`)}
              help={t(`terminals:settings.shiftEnter.${mode}.help`)}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SettingsRadioItem({ value, title, help }: { value: string; title: string; help: string }) {
  return (
    <DropdownMenuRadioItem value={value} closeOnClick={false} className="min-h-11 items-start py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{title}</span>
        <span className="text-muted-foreground text-xs">{help}</span>
      </span>
    </DropdownMenuRadioItem>
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
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), refetchInterval: NODES_REFRESH_MS });
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
            {list.map((node) => (
              <TerminalNodeRow
                key={node.id}
                node={node}
                ready={ready}
                busy={openTicket.isPending}
                opening={openTicket.isPending && openTicket.variables?.nodeId === node.id}
                onOpen={(shell) =>
                  openTicket.mutate({
                    nodeId: node.id,
                    ...INITIAL_SIZE,
                    ...(shell ? { shell } : {}),
                  })
                }
              />
            ))}
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
      // The list and the nav badge.
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.key() }),
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
  // Recently closed ones with how they ended (decided rows are deleted after 7 days; the list
  // comes most recently decided first, after the waiting ones); a failed load only hides them.
  const recent = useQuery(orpc.nodes.queued.list.queryOptions({ input: {} }));
  const closedAt = (item: { decidedAt: string | null; expiresAt: string }) =>
    item.decidedAt ?? item.expiresAt;
  const closed = (recent.data?.items.filter((item) => item.state !== "QUEUED") ?? [])
    .sort((a, b) => closedAt(b).localeCompare(closedAt(a)))
    .slice(0, RECENTLY_CLOSED_SHOWN);
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.nodes.queued.list.key() }),
      // The list and the nav badge.
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.key() }),
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
        {closed.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2 pt-3">
            <h3 className="text-sm font-medium">{t("terminals:queuedClosedTitle")}</h3>
            <ul className="flex min-w-0 flex-col gap-2">
              {closed.map((item) => (
                <li key={item.id} className="flex min-w-0 flex-col gap-0.5">
                  <code className="truncate font-mono text-xs">{item.command}</code>
                  <p className="text-xs text-muted-foreground">
                    {t(`terminals:queuedState.${item.state}`)} ·{" "}
                    {t("terminals:onNode", {
                      node: slugOf(item.nodeId) ?? t("terminals:unknownNode"),
                    })}{" "}
                    · <TimeAgo value={closedAt(item)} />
                  </p>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
