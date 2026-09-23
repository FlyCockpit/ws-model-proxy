import { useQuery } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@ws-model-proxy/ui/components/dropdown-menu";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { TerminalPane } from "@/components/terminal-pane";
import { WideContent } from "@/components/wide-content";
import { useTerminalSessions } from "@/hooks/use-terminal-sessions";
import {
  featureReasonKey,
  readCliDeviceFeatures,
  terminalOpenBlockReason,
} from "@/lib/cli-device-features";
import { orpc } from "@/utils/orpc";

function terminalRejectionLabel(t: (key: string) => string, reason: string | null): string {
  if (!reason) return "";
  const key = `dashboard:terminals.rejection.${reason}`;
  const translated = t(key);
  return translated === key ? reason : translated;
}

const APPROVAL_COMMAND_PREFIX = "wsmp terminal approve";

function deviceId(device: object): string | null {
  const value = Object.getOwnPropertyDescriptor(device, "id")?.value;
  return typeof value === "string" ? value : null;
}

function deviceText(device: object, key: "label" | "slug"): string | null {
  const value = Object.getOwnPropertyDescriptor(device, key)?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function TerminalsPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const devicesQuery = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const sessions = useTerminalSessions();
  const [menuOpen, setMenuOpen] = useState(false);
  const devices = devicesQuery.data ?? [];
  const active = sessions.tabs.find((tab) => tab.localId === sessions.activeLocalId) ?? null;
  const showSkeleton = devicesQuery.isPending && sessions.tabs.length === 0;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden">
      <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{t("dashboard:terminals.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("dashboard:terminals.description")}
          </p>
        </div>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                size="icon-touch"
                variant="outline"
                disabled={!sessions.identityReady || devicesQuery.isPending}
                aria-label={t("dashboard:terminals.add")}
              />
            }
          >
            <Plus aria-hidden="true" />
          </DropdownMenuTrigger>
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
                const label = deviceText(device, "label") ?? deviceText(device, "slug") ?? id;
                return (
                  <DropdownMenuItem
                    key={id}
                    disabled={block !== null}
                    className="min-h-11 items-start"
                    onClick={() => {
                      if (block) return;
                      sessions.openCli(id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="flex min-w-0 flex-col items-start gap-0.5">
                      <span className="max-w-full truncate">{label}</span>
                      {block ? (
                        <span className="text-xs text-muted-foreground">
                          {t(featureReasonKey(block))}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {sessions.status !== "open" ? (
        <p className="mb-2 text-sm text-muted-foreground">
          {t("dashboard:terminals.reconnecting")}
        </p>
      ) : null}

      {showSkeleton ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3" aria-busy="true">
          <span className="sr-only">{t("dashboard:terminals.loading")}</span>
          <div className="flex gap-2">
            <Skeleton className="h-11 w-36" />
            <Skeleton className="h-11 w-11" />
          </div>
          <Skeleton className="min-h-80 w-full flex-1" />
        </div>
      ) : devicesQuery.isError && devices.length === 0 ? (
        <InlineRetry
          message={t("dashboard:clis.loadFailed")}
          onRetry={() => void devicesQuery.refetch()}
        />
      ) : sessions.tabs.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">{t("dashboard:terminals.empty")}</p>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden">
          <WideContent className="mb-2 shrink-0">
            <div className="flex w-max items-center gap-1" role="tablist">
              {sessions.tabs.map((tab) => {
                const device = devices.find((entry) => deviceId(entry) === tab.cliDeviceId);
                const label = device
                  ? (deviceText(device, "label") ?? tab.cliDeviceId)
                  : tab.cliDeviceId;
                const selected = tab.localId === sessions.activeLocalId;
                return (
                  <div key={tab.localId} className="group flex shrink-0 items-center">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      className={cn(
                        "min-h-11 max-w-48 truncate px-3 text-sm",
                        selected ? "bg-muted text-foreground" : "text-muted-foreground",
                      )}
                      onClick={() => sessions.selectTab(tab.localId)}
                    >
                      {label}
                    </button>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex size-11 items-center justify-center text-muted-foreground",
                        selected
                          ? "visible"
                          : "invisible group-hover:visible group-focus-within:visible",
                      )}
                      aria-label={t("dashboard:terminals.close")}
                      onClick={() => sessions.closeTab(tab.localId)}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </WideContent>

          {active?.approvalCode ? (
            <div className="mb-3 min-w-0 rounded-md border p-3">
              <p className="text-sm font-medium">{t("dashboard:terminals.approvalTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("dashboard:terminals.approvalInstructions")}
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("dashboard:terminals.approvalCodeLabel")}
              </p>
              <p className="font-mono text-sm">{active.approvalCode}</p>
              <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain bg-muted px-3 py-2 font-mono text-sm">
                  {APPROVAL_COMMAND_PREFIX} {active.approvalCode}
                </code>
                <Button
                  type="button"
                  size="touch"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => {
                    const command = `${APPROVAL_COMMAND_PREFIX} ${active.approvalCode ?? ""}`;
                    void navigator.clipboard
                      .writeText(command)
                      .then(() => toast.success(t("dashboard:terminals.copied")));
                  }}
                >
                  {t("dashboard:terminals.copyCommand")}
                </Button>
              </div>
            </div>
          ) : null}

          {active?.phase === "rejected" && !active.approvalCode ? (
            <p className="mb-2 text-sm text-destructive">
              {t("dashboard:terminals.rejected", {
                reason: terminalRejectionLabel(t, active.rejectionReason),
              })}
            </p>
          ) : null}
          {active?.phase === "exited" ? (
            <p className="mb-2 text-sm text-muted-foreground">{t("dashboard:terminals.exited")}</p>
          ) : null}
          {active?.error ? (
            <p className="mb-2 text-sm text-destructive">
              {active.error === "input_dropped"
                ? t("dashboard:terminals.inputDropped")
                : t("dashboard:terminals.error")}
            </p>
          ) : null}

          <div className="relative min-h-80 min-w-0 flex-1 overflow-x-hidden overflow-y-hidden">
            {sessions.tabs.map((tab) => (
              <TerminalPane
                key={tab.localId}
                localId={tab.localId}
                active={tab.localId === sessions.activeLocalId}
                sendInput={sessions.sendInput}
                sendResize={sessions.sendResize}
                subscribeOutput={sessions.subscribeOutput}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
