import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/activity/commands")({
  component: ActivityCommandsPage,
});

type CommandState =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT"
  | "INTERRUPTED"
  | "UNKNOWN";

type CommandRow = {
  commandId: string;
  nodeSlug: string;
  actor: "USER" | "AGENT" | "SYSTEM";
  agentTokenName: string | null;
  program: string;
  state: CommandState;
  exitCode: number | null;
  startedAt: string;
  endsBy: string;
  finishedAt: string | null;
};

type LiveView = {
  state: CommandState;
  exitCode?: number;
  output: string | null;
  truncated?: boolean;
};

function ActivityCommandsPage() {
  const { t } = useTranslation(["activity"]);
  const commands = useInfiniteQuery(
    orpc.activity.commands.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ limit: 50, ...(cursor ? { cursor } : {}) }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = commands.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="activityCommands" />
      {commands.isPending ? (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : commands.isError ? (
        <InlineRetry
          message={t("activity:commands.loadFailed")}
          onRetry={() => commands.refetch()}
        />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            {t("activity:commands.empty")}
          </CardContent>
        </Card>
      ) : (
        <>
          <ul className="flex min-w-0 flex-col gap-2">
            {rows.map((row) => (
              <li key={row.commandId}>
                <CommandCard row={row} />
              </li>
            ))}
          </ul>
          {commands.hasNextPage ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="self-center"
              disabled={commands.isFetchingNextPage}
              onClick={() => void commands.fetchNextPage()}
            >
              {t("activity:commands.loadMore")}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

const STATE_TONE: Record<CommandState, string> = {
  RUNNING: "text-sky-700 dark:text-sky-400",
  SUCCEEDED: "text-emerald-700 dark:text-emerald-400",
  FAILED: "text-destructive",
  CANCELLED: "text-muted-foreground",
  TIMED_OUT: "text-amber-700 dark:text-amber-400",
  INTERRUPTED: "text-amber-700 dark:text-amber-400",
  UNKNOWN: "text-muted-foreground",
};

function CommandCard({ row }: { row: CommandRow }) {
  const { t } = useTranslation(["activity"]);
  const queryClient = useQueryClient();
  const [live, setLive] = useState<LiveView | null>(null);
  const fetchLive = useMutation(
    orpc.nodes.commands.get.mutationOptions({
      onSuccess: async (view) => {
        setLive(view);
        if (view.state !== row.state) {
          await queryClient.invalidateQueries({ queryKey: orpc.activity.commands.list.key() });
        }
      },
    }),
  );
  // The list row wins once it is final; a live snapshot only adds detail while it runs.
  const state = row.state !== "RUNNING" ? row.state : (live?.state ?? row.state);
  const exitCode = row.exitCode ?? live?.exitCode;
  const by =
    row.actor === "AGENT"
      ? row.agentTokenName
        ? t("activity:commands.byAgent", { name: row.agentTokenName })
        : t("activity:commands.byUnknownAgent")
      : row.actor === "USER"
        ? t("activity:commands.byPerson")
        : t("activity:commands.bySystem");
  return (
    <Card size="sm">
      <CardContent className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="min-w-0 break-all font-mono text-sm">
            {row.nodeSlug} · {row.program}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            <TimeAgo value={row.startedAt} />
          </span>
        </div>
        <p className="text-xs">
          <span className={cn("font-medium", STATE_TONE[state])}>
            {t(`activity:commands.state.${state}`)}
          </span>
          {exitCode !== null && exitCode !== undefined ? (
            <span className="text-muted-foreground">
              {" · "}
              {t("activity:commands.exit", { code: exitCode })}
            </span>
          ) : null}
          <span className="text-muted-foreground"> · {by}</span>
          {state === "RUNNING" ? (
            <span className="text-muted-foreground">
              {" · "}
              {t("activity:commands.endsBy")} <TimeAgo value={row.endsBy} />
            </span>
          ) : null}
        </p>
        {state === "INTERRUPTED" ? (
          <p className="text-xs text-muted-foreground">{t("activity:commands.interruptedHint")}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={fetchLive.isPending}
            onClick={() => fetchLive.mutate({ commandId: row.commandId })}
          >
            {live ? t("activity:commands.refresh") : t("activity:commands.showOutput")}
          </Button>
          {state === "RUNNING" ? (
            <Button
              type="button"
              variant="ghost"
              size="touch"
              disabled={fetchLive.isPending}
              onClick={() =>
                fetchLive.mutate(
                  { commandId: row.commandId, cancel: true },
                  { onSuccess: () => toast.success(t("activity:commands.cancelled")) },
                )
              }
            >
              {t("activity:commands.cancel")}
            </Button>
          ) : null}
        </div>
        {live ? <CommandOutput live={live} /> : null}
      </CardContent>
    </Card>
  );
}

function CommandOutput({ live }: { live: LiveView }) {
  const { t } = useTranslation(["activity"]);
  if (live.output === null) {
    return <p className="text-xs text-muted-foreground">{t("activity:commands.offline")}</p>;
  }
  return (
    <div className="min-w-0 space-y-1">
      {live.truncated ? (
        <p className="text-xs text-muted-foreground">{t("activity:commands.truncated")}</p>
      ) : null}
      <WideContent className="max-h-80 overflow-y-auto rounded-md border bg-muted/50 p-3">
        <pre className="w-max font-mono text-xs leading-relaxed">
          {live.output.length > 0 ? live.output : t("activity:commands.noOutput")}
        </pre>
      </WideContent>
    </div>
  );
}
