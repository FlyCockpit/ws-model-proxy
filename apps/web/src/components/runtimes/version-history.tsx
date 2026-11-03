import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { WideContent } from "@/components/wide-content";
import { collapseUnchanged, type DiffHunkLine, diffLines, stableJsonLines } from "@/lib/line-diff";
import { orpc } from "@/utils/orpc";

import { versionDocument } from "./version-history-utils";

type VersionSummary = Awaited<
  ReturnType<AppRouterClient["runtimes"]["versions"]["list"]>
>["items"][number];

const PAGE = 20;

/**
 * Each shown diff line with a key from where it sits: its line number in the old and the new
 * document (a skip covers unchanged lines of both). Every line moves past at least one of
 * them, so no two lines share a key.
 */
function keyedHunkLines(lines: readonly DiffHunkLine[]) {
  let before = 0;
  let after = 0;
  return lines.map((line) => {
    const key = `${line.kind}-${before}-${after}`;
    const step = line.kind === "skip" ? line.count : 1;
    if (line.kind !== "add") before += step;
    if (line.kind !== "remove") after += step;
    return { key, line };
  });
}

/**
 * Every version of a runtime, newest first: who wrote it (agent-written ones marked), whether it
 * applied live or needs a restart, its note, and its changes against the version before it.
 */
export function VersionHistory({
  runtimeId,
  kind,
}: {
  runtimeId: string;
  kind: "ALWAYS_ON" | "STARTABLE";
}) {
  const { t } = useTranslation(["dashboard"]);
  const versions = useInfiniteQuery(
    orpc.runtimes.versions.list.infiniteOptions({
      input: (cursor: string | undefined) => ({ runtimeId, limit: PAGE, cursor }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const rows = versions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:runtime.versions")}</CardTitle>
        <CardDescription>{t("dashboard:runtime.versionsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {versions.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : versions.isError ? (
          <InlineRetry onRetry={() => versions.refetch()} />
        ) : (
          <>
            <ul className="flex min-w-0 flex-col divide-y">
              {rows.map((version, index) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  // Instances of a startable runtime restart; an always-on one has none to.
                  showLaunch={kind === "STARTABLE"}
                  // Newest first: the next row is the version before this one.
                  previous={rows[index + 1] ?? null}
                />
              ))}
            </ul>
            {versions.hasNextPage ? (
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  disabled={versions.isFetchingNextPage}
                  onClick={() => versions.fetchNextPage()}
                >
                  {t("dashboard:runtime.history.older")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VersionRow({
  version,
  previous,
  showLaunch,
}: {
  version: VersionSummary;
  previous: VersionSummary | null;
  showLaunch: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  // The version before this one is on a page not loaded yet.
  const previousMissing = previous === null && version.version > 1;
  const diffId = `version-diff-${version.id}`;
  return (
    <li className="flex min-w-0 flex-col gap-2 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-sm">v{version.version}</span>
        {version.editor.actor === "AGENT" ? (
          <StatusPill tone="info">{t("dashboard:runtime.history.agentWritten")}</StatusPill>
        ) : (
          <StatusPill tone="muted">
            {t(`dashboard:runtime.editor.${version.editor.actor}`)}
          </StatusPill>
        )}
        {!showLaunch || version.version === 1 ? null : version.launchChanged ? (
          <StatusPill tone="busy">{t("dashboard:runtime.needsRestartBadge")}</StatusPill>
        ) : (
          <StatusPill tone="good">{t("dashboard:runtime.appliesLive")}</StatusPill>
        )}
        <span className="text-xs text-muted-foreground">
          <TimeAgo value={version.createdAt} />
        </span>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="ml-auto"
          aria-expanded={open}
          aria-controls={diffId}
          disabled={previousMissing}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? t("dashboard:runtime.history.hideChanges")
            : t("dashboard:runtime.history.showChanges")}
        </Button>
      </div>
      {version.note ? (
        <p className="min-w-0 break-words text-sm text-muted-foreground">{version.note}</p>
      ) : null}
      {previousMissing ? (
        <p className="text-xs text-muted-foreground">{t("dashboard:runtime.history.loadOlder")}</p>
      ) : null}
      {open ? (
        <div id={diffId}>
          <VersionDiff versionId={version.id} previousId={previous?.id ?? null} />
        </div>
      ) : null}
    </li>
  );
}

/** The changes a version made, as a line diff of its definition against the one before. */
export function VersionDiff({
  versionId,
  previousId,
}: {
  versionId: string;
  previousId: string | null;
}) {
  const { t } = useTranslation(["dashboard"]);
  const current = useQuery(orpc.runtimes.versions.get.queryOptions({ input: { versionId } }));
  const previous = useQuery(
    orpc.runtimes.versions.get.queryOptions({
      input: previousId ? { versionId: previousId } : skipToken,
    }),
  );
  if (current.isPending || (previousId && previous.isPending))
    return <Skeleton className="h-32 w-full" aria-hidden="true" />;
  if (current.isError || (previousId && previous.isError))
    return (
      <InlineRetry
        message={t("dashboard:runtime.history.diffFailed")}
        onRetry={() => {
          void current.refetch();
          if (previousId) void previous.refetch();
        }}
      />
    );
  const before = previousId ? stableJsonLines(versionDocument(previous.data ?? null)) : [];
  const after = stableJsonLines(versionDocument(current.data ?? null));
  const lines = diffLines(before, after);
  if (!lines.some((line) => line.kind !== "same"))
    return (
      <p className="text-sm text-muted-foreground">{t("dashboard:runtime.history.noChanges")}</p>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {previousId ? null : (
        <p className="text-xs text-muted-foreground">{t("dashboard:runtime.history.first")}</p>
      )}
      <WideContent className="rounded-md border bg-muted/30">
        <div
          role="group"
          className="w-max min-w-full py-2 font-mono text-xs leading-5"
          aria-label={t("dashboard:runtime.history.diffLabel")}
        >
          {keyedHunkLines(collapseUnchanged(lines)).map(({ key, line }) =>
            line.kind === "skip" ? (
              <div key={key} className="px-3 text-muted-foreground">
                {t("dashboard:runtime.history.unchanged", { count: line.count })}
              </div>
            ) : (
              <div
                key={key}
                data-diff={line.kind}
                className={cn(
                  "px-3 whitespace-pre",
                  line.kind === "add" && "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200",
                  line.kind === "remove" && "bg-destructive/15 text-destructive",
                )}
              >
                <span aria-hidden="true">
                  {line.kind === "add" ? "+ " : line.kind === "remove" ? "- " : "  "}
                </span>
                <span className="sr-only">
                  {line.kind === "add"
                    ? t("dashboard:runtime.history.added")
                    : line.kind === "remove"
                      ? t("dashboard:runtime.history.removed")
                      : ""}
                </span>
                {line.text}
              </div>
            ),
          )}
        </div>
      </WideContent>
    </div>
  );
}
