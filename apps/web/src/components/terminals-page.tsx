import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { EllipsisVertical, Plus, ShieldAlert, ShieldCheck, SquareTerminal, X } from "lucide-react";
import { type ComponentProps, createContext, type ReactNode, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import {
  cliIdentitiesNeedAttention,
  cliIdentitiesToShow,
  TerminalCliIdentities,
} from "@/components/terminal-cli-identities";
import { TerminalPane } from "@/components/terminal-pane";
import { TerminalStatusDot } from "@/components/terminal-status-dot";
import { WideContent } from "@/components/wide-content";
import { TERMINAL_GONE, type TerminalTab } from "@/hooks/use-terminal-sessions";
import { deviceId, deviceText, useTerminalWorkspace } from "@/hooks/use-terminal-workspace";
import {
  featureReasonKey,
  readCliDeviceFeatures,
  terminalOpenBlockReason,
} from "@/lib/cli-device-features";
import { TERMINAL_CHROME_VARS } from "@/lib/terminal-theme";
import { followSize, writerStatusKey } from "@/lib/terminal-writer";

function terminalRejectionLabel(t: (key: string) => string, reason: string | null): string {
  if (!reason) return "";
  const key = `dashboard:terminals.rejection.${reason}`;
  const translated = t(key);
  return translated === key ? reason : translated;
}

const APPROVAL_COMMAND_PREFIX = "wsmp terminal approve";

/**
 * False while another dashboard page hides the workspace. Menus and dialogs
 * portal outside it, so they close (and stay closed) while it is hidden.
 */
const WorkspaceVisibleContext = createContext(true);

/** A 44px icon button styled for the dark terminal chrome in either site theme. */
function ChromeButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex size-11 shrink-0 items-center justify-center text-(--term-muted) hover:bg-(--term-hover) hover:text-(--term-fg) focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        className,
      )}
      {...props}
    />
  );
}

/** A labeled button for notices on the dark chrome. */
function ChromeTextButton({ className, ...props }: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-(--term-border) px-3 text-sm text-(--term-fg) hover:bg-(--term-hover) focus-visible:outline-2 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

/** The CLI picker. `trigger` is the element that opens it. */
function NewTerminalMenu({
  trigger,
  children,
}: {
  trigger: ComponentProps<typeof DropdownMenuTrigger>["render"];
  children: ReactNode;
}) {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  const visible = useContext(WorkspaceVisibleContext);
  const [open, setOpen] = useState(false);
  if (!visible && open) setOpen(false);
  const devices = workspace.devicesQuery.data ?? [];
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        // The provider's CLI list outlives page visits; refresh availability
        // (a CLI may have come online) whenever the picker opens.
        if (next) {
          void workspace.devicesQuery.refetch();
          void workspace.refreshClis();
        }
        setOpen(next);
      }}
    >
      <DropdownMenuTrigger render={trigger}>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {devices.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground">
            {t("dashboard:terminals.emptyClis")}
          </p>
        ) : (
          devices.map((device) => {
            const id = deviceId(device);
            if (!id) return null;
            const features = readCliDeviceFeatures(device);
            const block = terminalOpenBlockReason(features.features.terminal);
            const trust = workspace.cliTrust[id]?.status;
            const identityBlock =
              trust === "changed"
                ? "dashboard:terminals.rejection.identity_changed"
                : trust === "invalid"
                  ? "dashboard:terminals.rejection.identity_invalid"
                  : null;
            const label = deviceText(device, "label") ?? deviceText(device, "slug") ?? id;
            return (
              <DropdownMenuItem
                key={id}
                disabled={block !== null || identityBlock !== null}
                className="min-h-11 items-start"
                onClick={() => {
                  if (block || identityBlock) return;
                  workspace.openCli(id);
                  setOpen(false);
                }}
              >
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="max-w-full truncate">{label}</span>
                  {block ? (
                    <span className="text-xs text-muted-foreground">
                      {t(featureReasonKey(block))}
                    </span>
                  ) : identityBlock ? (
                    <span className="text-xs text-destructive">{t(identityBlock)}</span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabStrip({
  onEnd,
  onShowIdentities,
}: {
  onEnd: (localId: string) => void;
  onShowIdentities: () => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  const active = workspace.tabs.find((tab) => tab.localId === workspace.activeLocalId) ?? null;
  const identities = cliIdentitiesToShow(workspace.clis, workspace.cliTrust);
  const attention = cliIdentitiesNeedAttention(workspace.clis, workspace.cliTrust);
  const canEnd =
    active?.terminalId != null && active.phase !== "exited" && active.phase !== "rejected";
  const addDisabled = !workspace.identityReady || workspace.devicesQuery.isPending;
  const visible = useContext(WorkspaceVisibleContext);
  const [actionsOpen, setActionsOpen] = useState(false);
  if (!visible && actionsOpen) setActionsOpen(false);

  return (
    <div className="flex min-w-0 shrink-0 items-stretch border-b border-(--term-border) bg-(--term-chrome)">
      <WideContent className="flex-1 no-scrollbar">
        <div className="flex w-max items-stretch" role="tablist">
          {workspace.tabs.map((tab) => {
            const selected = tab.localId === workspace.activeLocalId;
            return (
              <div
                key={tab.localId}
                className={cn(
                  "group flex shrink-0 items-center border-e border-(--term-border)",
                  selected
                    ? "bg-(--term-bg) text-(--term-fg) shadow-[inset_0_2px_0_var(--color-primary)]"
                    : "text-(--term-muted) hover:bg-(--term-hover) hover:text-(--term-fg)",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="flex min-h-11 max-w-56 items-center gap-2 ps-3 pe-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                  onClick={() => workspace.selectTab(tab.localId)}
                >
                  <TerminalStatusDot tab={tab} />
                  <span className="truncate">{workspace.tabLabel(tab)}</span>
                </button>
                <ChromeButton
                  className={cn(
                    "hover:bg-transparent",
                    selected
                      ? "visible"
                      : "invisible group-hover:visible group-focus-within:visible",
                  )}
                  aria-label={t("dashboard:terminals.close")}
                  onClick={() => workspace.detachTab(tab.localId)}
                >
                  <X aria-hidden="true" />
                </ChromeButton>
              </div>
            );
          })}
          <NewTerminalMenu
            trigger={
              <ChromeButton disabled={addDisabled} aria-label={t("dashboard:terminals.add")} />
            }
          >
            <Plus aria-hidden="true" />
          </NewTerminalMenu>
        </div>
      </WideContent>

      {identities.length > 0 ? (
        <ChromeButton
          aria-label={t("dashboard:terminals.identity.title")}
          title={t("dashboard:terminals.identity.title")}
          className={attention ? "text-red-400 hover:text-red-300" : undefined}
          onClick={onShowIdentities}
        >
          {attention ? <ShieldAlert aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
        </ChromeButton>
      ) : null}
      {canEnd && active ? (
        <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
          <DropdownMenuTrigger
            render={<ChromeButton aria-label={t("dashboard:terminals.actions")} />}
          >
            <EllipsisVertical aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              variant="destructive"
              className="min-h-11"
              onClick={() => onEnd(active.localId)}
            >
              {t("dashboard:terminals.endSession")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function IdentitiesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dashboard:terminals.identity.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:terminals.identity.description")}</DialogDescription>
        </DialogHeader>
        <TerminalCliIdentities
          clis={workspace.clis}
          trust={workspace.cliTrust}
          labelFor={workspace.labelFor}
          onTrustNewKey={workspace.trustNewKey}
        />
      </DialogContent>
    </Dialog>
  );
}

function Banner({ tone = "info", children }: { tone?: "info" | "problem"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 shrink-0 flex-col gap-2 border-b border-(--term-border) bg-(--term-chrome) px-4 py-2 text-sm sm:flex-row sm:items-center",
        tone === "problem" ? "text-red-300" : "text-(--term-fg)",
      )}
    >
      {children}
    </div>
  );
}

/** Notices about the connection, identities, and the active tab. */
function Notices({ onReviewIdentities }: { onReviewIdentities: () => void }) {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  const active = workspace.tabs.find((tab) => tab.localId === workspace.activeLocalId) ?? null;
  const activeUnverified =
    active !== null && workspace.cliTrust[active.cliDeviceId]?.status === "unverified";
  const attention = cliIdentitiesNeedAttention(workspace.clis, workspace.cliTrust);

  return (
    <>
      {workspace.status !== "open" ? (
        <Banner>
          <p className="min-w-0 text-(--term-muted)">{t("dashboard:terminals.reconnecting")}</p>
        </Banner>
      ) : null}
      {attention ? (
        <Banner tone="problem">
          <p className="min-w-0 flex-1">{t("dashboard:terminals.identity.attention")}</p>
          <ChromeTextButton onClick={onReviewIdentities}>
            {t("dashboard:terminals.identity.review")}
          </ChromeTextButton>
        </Banner>
      ) : null}
      {active?.approvalCode ? <ApprovalNotice code={active.approvalCode} /> : null}
      {active?.phase === "rejected" && !active.approvalCode ? (
        <Banner tone="problem">
          <p className="min-w-0">
            {t("dashboard:terminals.rejected", {
              reason: terminalRejectionLabel(t, active.rejectionReason),
            })}
          </p>
        </Banner>
      ) : null}
      {activeUnverified && active?.phase !== "rejected" ? (
        <Banner>
          <p className="min-w-0 text-(--term-muted)">
            {t("dashboard:terminals.identity.activeUnverified")}
          </p>
        </Banner>
      ) : null}
      {active?.phase === "exited" ? (
        <Banner>
          <p className="min-w-0 text-(--term-muted)">
            {active.error === TERMINAL_GONE
              ? t("dashboard:terminals.gone")
              : t("dashboard:terminals.exited")}
          </p>
        </Banner>
      ) : null}
      {active?.error === "detached" ? (
        <Banner>
          <p className="min-w-0 flex-1 text-(--term-muted)">
            {t("dashboard:terminals.openElsewhere")}
          </p>
          <ChromeTextButton onClick={() => workspace.selectTab(active.localId)}>
            {t("dashboard:terminals.viewHere")}
          </ChromeTextButton>
        </Banner>
      ) : active?.error === "slow" ? (
        <Banner>
          <p className="min-w-0 text-(--term-muted)">{t("dashboard:terminals.slowReconnecting")}</p>
        </Banner>
      ) : active?.error && active.error !== TERMINAL_GONE ? (
        <Banner tone="problem">
          <p className="min-w-0">
            {active.error === "input_dropped"
              ? t("dashboard:terminals.inputDropped")
              : t("dashboard:terminals.error")}
          </p>
        </Banner>
      ) : null}
    </>
  );
}

function ApprovalNotice({ code }: { code: string }) {
  const { t } = useTranslation(["dashboard"]);
  const command = `${APPROVAL_COMMAND_PREFIX} ${code}`;
  return (
    <div className="shrink-0 border-b border-(--term-border) bg-(--term-chrome) px-4 py-3 text-(--term-fg)">
      <p className="text-sm font-medium">{t("dashboard:terminals.approvalTitle")}</p>
      <p className="mt-1 text-sm text-(--term-muted)">
        {t("dashboard:terminals.approvalInstructions")}
      </p>
      <p className="mt-3 text-xs text-(--term-muted)">
        {t("dashboard:terminals.approvalCodeLabel")}
      </p>
      <p className="font-mono text-sm">{code}</p>
      <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-md bg-(--term-bg) px-3 py-2 font-mono text-sm">
          {command}
        </code>
        <ChromeTextButton
          onClick={() => {
            void navigator.clipboard
              .writeText(command)
              .then(() => toast.success(t("dashboard:terminals.copied")));
          }}
        >
          {t("dashboard:terminals.copyCommand")}
        </ChromeTextButton>
      </div>
    </div>
  );
}

/** Phase, writer, viewers, and size of the active tab. */
function StatusBar({ tab }: { tab: TerminalTab | null }) {
  const { t } = useTranslation(["dashboard"]);
  if (!tab) return null;
  const writerKey = tab.multiViewer && tab.phase === "live" ? writerStatusKey(tab.writer) : null;
  const follow = tab.phase === "live" ? followSize(tab) : null;
  const size =
    tab.phase === "live" && tab.ptyCols !== null && tab.ptyRows !== null
      ? { cols: tab.ptyCols, rows: tab.ptyRows }
      : null;
  return (
    <div className="flex min-h-8 min-w-0 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-(--term-border) bg-(--term-chrome) px-3 py-1 text-xs text-(--term-muted)">
      <span className="flex items-center gap-2">
        <TerminalStatusDot tab={tab} />
        {t(`dashboard:terminals.phase.${tab.phase}`)}
      </span>
      {writerKey ? (
        <span className={tab.writer === "you" ? "text-(--term-fg)" : undefined}>
          {t(writerKey)}
        </span>
      ) : null}
      {tab.multiViewer && tab.phase === "live" ? (
        <span>{t("dashboard:terminals.status.viewers", { count: tab.viewerCount })}</span>
      ) : null}
      {follow ? (
        <span>
          {t("dashboard:terminals.status.following", { cols: follow.cols, rows: follow.rows })}
        </span>
      ) : size ? (
        <span className="ms-auto font-mono">
          {t("dashboard:terminals.status.size", { cols: size.cols, rows: size.rows })}
        </span>
      ) : null}
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation(["dashboard"]);
  const workspace = useTerminalWorkspace();
  const addDisabled = !workspace.identityReady || workspace.devicesQuery.isPending;
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center">
      <SquareTerminal className="size-10 text-(--term-muted)" aria-hidden="true" />
      <p className="text-base font-medium text-(--term-fg)">{t("dashboard:terminals.empty")}</p>
      <p className="max-w-md text-sm text-(--term-muted)">{t("dashboard:terminals.description")}</p>
      <NewTerminalMenu
        trigger={
          <Button type="button" size="touch" className="mt-2 gap-2" disabled={addDisabled} />
        }
      >
        <Plus aria-hidden="true" />
        {t("dashboard:terminals.add")}
      </NewTerminalMenu>
    </div>
  );
}

/**
 * The terminal workspace. The dashboard frame keeps it mounted (hidden) on
 * other dashboard pages so open terminals keep their screens and scrollback.
 */
export function TerminalWorkspaceView({ visible }: { visible: boolean }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const workspace = useTerminalWorkspace();
  const [endTarget, setEndTarget] = useState<string | null>(null);
  const [identitiesOpen, setIdentitiesOpen] = useState(false);
  // Browser Back can hide the workspace with a dialog open; close it.
  if (!visible && (endTarget !== null || identitiesOpen)) {
    setEndTarget(null);
    setIdentitiesOpen(false);
  }
  const active = workspace.tabs.find((tab) => tab.localId === workspace.activeLocalId) ?? null;
  const devicesQuery = workspace.devicesQuery;
  const showSkeleton = devicesQuery.isPending && workspace.tabs.length === 0;
  // Open terminals stay usable when the CLI list fails; only the empty state needs it.
  const loadFailed =
    devicesQuery.isError && (devicesQuery.data ?? []).length === 0 && workspace.tabs.length === 0;

  return (
    <WorkspaceVisibleContext.Provider value={visible}>
      <section
        aria-label={t("dashboard:terminals.title")}
        style={TERMINAL_CHROME_VARS}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--term-bg) text-(--term-fg)"
      >
        <TabStrip onEnd={setEndTarget} onShowIdentities={() => setIdentitiesOpen(true)} />
        <Notices onReviewIdentities={() => setIdentitiesOpen(true)} />

        <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
          {showSkeleton ? (
            <div className="flex h-full flex-col gap-2 p-4" aria-busy="true">
              <span className="sr-only">{t("dashboard:terminals.loading")}</span>
              <Skeleton className="h-4 w-64 bg-(--term-hover)" />
              <Skeleton className="h-4 w-40 bg-(--term-hover)" />
            </div>
          ) : loadFailed ? (
            <div className="flex h-full items-center justify-center p-4">
              <InlineRetry
                message={t("dashboard:clis.loadFailed")}
                onRetry={() => void devicesQuery.refetch()}
              />
            </div>
          ) : workspace.tabs.length === 0 ? (
            <EmptyState />
          ) : (
            workspace.tabs.map((tab) => (
              <TerminalPane
                key={tab.localId}
                localId={tab.localId}
                active={visible && tab.localId === workspace.activeLocalId}
                follow={followSize(tab)}
                sendInput={workspace.sendInput}
                sendResize={workspace.sendResize}
                subscribeOutput={workspace.subscribeOutput}
              />
            ))
          )}
        </div>

        <StatusBar tab={active} />

        <IdentitiesDialog open={identitiesOpen} onOpenChange={setIdentitiesOpen} />
        <AlertDialog
          open={endTarget !== null}
          onOpenChange={(open) => {
            if (!open) setEndTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("dashboard:terminals.endSessionTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("dashboard:terminals.endSessionDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="min-h-11 w-full sm:w-auto">
                {t("common:actions.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                className="min-h-11 w-full sm:w-auto"
                onClick={() => {
                  if (endTarget) workspace.endSession(endTarget);
                  setEndTarget(null);
                }}
              >
                {t("dashboard:terminals.endSession")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
    </WorkspaceVisibleContext.Provider>
  );
}
