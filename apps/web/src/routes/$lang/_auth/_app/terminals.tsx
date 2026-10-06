import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
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
import { SquareTerminal } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/terminals")({
  component: TerminalsPage,
});

/** The size a terminal opens at before the browser pane fits it. */
const INITIAL_SIZE = { cols: 120, rows: 32 };

/**
 * TODO(server): flip once apps/server serves relay 3.0 browser terminals by ticket and the page
 * attaches xterm (`use-terminal-sessions`) to it. Until then Open and Run stay disabled: a
 * ticket nothing attaches to would use up a queued command and open an idle shell.
 */
const BROWSER_TERMINALS_READY = false;

function TerminalsPage() {
  const { t } = useTranslation(["terminals"]);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="terminals" />
      {BROWSER_TERMINALS_READY ? null : (
        <Card>
          <CardContent className="flex min-w-0 items-start gap-2 text-sm">
            <SquareTerminal aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0">{t("terminals:attachUnavailable")}</span>
          </CardContent>
        </Card>
      )}
      <QueuedCommands />
      <TerminalNodes />
    </div>
  );
}

function TerminalNodes() {
  const { t } = useTranslation(["terminals"]);
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const openTicket = useMutation(orpc.nodes.terminals.openTicket.mutationOptions());
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
                    disabled={!BROWSER_TERMINALS_READY || !full || !online || openTicket.isPending}
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

function QueuedCommands() {
  const { t } = useTranslation(["terminals"]);
  const queryClient = useQueryClient();
  const queued = useQuery(orpc.nodes.queued.list.queryOptions({ input: { state: "QUEUED" } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const slugOf = (nodeId: string) =>
    nodes.data?.nodes.find((node) => node.id === nodeId)?.slug ?? t("terminals:unknownNode");
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.nodes.queued.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.activity.needsYou.list.key() }),
    ]);
  };
  const run = useMutation(
    orpc.nodes.queued.run.mutationOptions({
      onSettled: invalidate,
    }),
  );
  const dismiss = useMutation(
    orpc.nodes.queued.dismiss.mutationOptions({
      onSuccess: () => toast.success(t("terminals:dismissed")),
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
                {t("terminals:onNode", { node: slugOf(item.nodeId) })} · {t("terminals:fromAgent")}{" "}
                · {t("terminals:expires")} <TimeAgo value={item.expiresAt} />
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="touch"
                  disabled={!BROWSER_TERMINALS_READY || run.isPending}
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
