import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { SegmentedControl } from "@/components/segmented-control";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import type { ProviderAccountDetail } from "./provider-action";

const PAGE = 25;
type Tab = "attempts" | "usage";
const ATTEMPT_TONE: Record<string, PillTone> = {
  ACTIVE: "busy",
  COMPLETED: "good",
  FAILED: "bad",
  CANCELLED: "muted",
  EXPIRED: "muted",
};

/** This account's cloud attempts and usage/cost rows, newest first. */
export function ProviderActivity({ account }: { account: ProviderAccountDetail }) {
  const { t } = useTranslation(["dashboard"]);
  const [tab, setTab] = useState<Tab>("attempts");
  const modelName = (id: string | null) =>
    id === null
      ? t("dashboard:providers.activity.unknownModel")
      : (account.models.find((model) => model.id === id)?.upstreamModelId ??
        t("dashboard:providers.activity.removedModel"));
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:providers.activity.title")}</CardTitle>
        <CardDescription>{t("dashboard:providers.activity.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <SegmentedControl
          value={tab}
          onChange={setTab}
          ariaLabel={t("dashboard:providers.activity.title")}
          items={[
            { value: "attempts", label: t("dashboard:providers.activity.attempts") },
            { value: "usage", label: t("dashboard:providers.activity.usage") },
          ]}
        />
        {tab === "attempts" ? (
          <AttemptList accountId={account.id} modelName={modelName} />
        ) : (
          <UsageList accountId={account.id} modelName={modelName} />
        )}
      </CardContent>
    </Card>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

function AttemptList({
  accountId,
  modelName,
}: {
  accountId: string;
  modelName: (id: string | null) => string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const attempts = useInfiniteQuery(
    orpc.providers.attempts.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        accountId,
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  if (attempts.isPending) return <ListSkeleton />;
  if (attempts.isError)
    return (
      <InlineRetry
        message={t("dashboard:providers.activity.loadFailed")}
        onRetry={() => attempts.refetch()}
      />
    );
  const rows = attempts.data.pages.flatMap((page) => page.items);
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        {t("dashboard:providers.activity.noAttempts")}
      </p>
    );
  return (
    <>
      <ul className="flex min-w-0 flex-col divide-y">
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-col gap-0.5 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <StatusPill tone={ATTEMPT_TONE[row.state] ?? "muted"}>
                {t(`dashboard:providers.activity.attemptState.${row.state}`)}
              </StatusPill>
              <span className="min-w-0 flex-1 break-all font-mono text-sm">
                {modelName(row.providerModelId)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <TimeAgo value={row.createdAt} />
              </span>
            </div>
            {row.httpStatusCode !== null || row.errorClass ? (
              <p className="break-all text-xs text-muted-foreground">
                {[
                  row.httpStatusCode !== null
                    ? t("dashboard:providers.activity.http", { status: row.httpStatusCode })
                    : null,
                  row.errorClass,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {attempts.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-center"
          disabled={attempts.isFetchingNextPage}
          onClick={() => void attempts.fetchNextPage()}
        >
          {t("dashboard:providers.activity.loadMore")}
        </Button>
      ) : null}
    </>
  );
}

function UsageList({
  accountId,
  modelName,
}: {
  accountId: string;
  modelName: (id: string | null) => string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const usage = useInfiniteQuery(
    orpc.providers.usage.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        accountId,
        limit: PAGE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  if (usage.isPending) return <ListSkeleton />;
  if (usage.isError)
    return (
      <InlineRetry
        message={t("dashboard:providers.activity.loadFailed")}
        onRetry={() => usage.refetch()}
      />
    );
  const rows = usage.data.pages.flatMap((page) => page.items);
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">{t("dashboard:providers.activity.noUsage")}</p>
    );
  return (
    <>
      <ul className="flex min-w-0 flex-col divide-y">
        {rows.map((row) => (
          <li key={row.id} className="flex min-w-0 flex-col gap-0.5 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-all font-mono text-sm">
                {modelName(row.providerModelId)}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                <TimeAgo value={row.createdAt} />
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("dashboard:providers.activity.tokens", {
                input: row.inputTokens ?? 0,
                output: row.outputTokens ?? 0,
              })}
              {" · "}
              {row.cost !== null
                ? t("dashboard:providers.activity.cost", {
                    cost: row.cost,
                    currency: row.currency ?? "",
                  })
                : t("dashboard:providers.activity.noCost")}
              {" · "}
              {t(`dashboard:providers.activity.confidence.${row.confidence}`)}
            </p>
          </li>
        ))}
      </ul>
      {usage.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="touch"
          className="self-center"
          disabled={usage.isFetchingNextPage}
          onClick={() => void usage.fetchNextPage()}
        >
          {t("dashboard:providers.activity.loadMore")}
        </Button>
      ) : null}
    </>
  );
}
