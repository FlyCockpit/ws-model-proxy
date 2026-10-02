import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  ENGINE_LOAD_SPARKLINE_HEIGHT_PX,
  EngineLoadSparkline,
  type EngineLoadSparklinePoint,
} from "@/components/engine-load-sparkline";
import { InlineRetry } from "@/components/inline-retry";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

type RoutingRulesView = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["getPoolRoutingRules"]>
>;
type MemberView = RoutingRulesView["members"][number];
type HistoryView = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["getEngineLoadHistory"]>
>;

function Pill({
  children,
  tone,
  testId,
}: {
  children: ReactNode;
  tone: "warn" | "muted";
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex min-h-6 items-center border px-2 text-xs font-medium",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function provenanceKey(
  load: MemberView["engineLoad"],
  seriesSource: string | null | undefined,
): string {
  if (load.loadSource === "custom" || seriesSource === "custom") return "custom";
  if (seriesSource === "llama.cpp-slots" || load.engineKind === "LLAMA_CPP")
    return "builtinLlamaSlots";
  if (seriesSource === "llama.cpp-metrics") return "builtinLlamaMetrics";
  if (seriesSource === "sglang-metrics" || load.engineKind === "SGLANG") return "builtinSglang";
  return "builtinVllm";
}

/**
 * Per-member live engine load (S-D): running/waiting/KV %, a sparkline of the
 * last 30 minutes, a stale badge and the "use engine load" override.
 */
export function PoolEngineLoad({ poolId, members }: { poolId: string; members: MemberView[] }) {
  const { t } = useTranslation(["dashboard"]);
  const history = useQuery({
    ...orpc.forwarderManagement.getEngineLoadHistory.queryOptions({ input: { poolId } }),
    refetchInterval: historyRefetchInterval,
  });
  if (members.length === 0) return null;
  const byMember = new Map(
    (history.data?.members ?? []).map((entry) => [entry.poolMemberId, entry]),
  );
  return (
    <section className="min-w-0 space-y-2" aria-labelledby="pool-engine-load-title">
      <div>
        <h4 id="pool-engine-load-title" className="text-sm font-semibold">
          {t("dashboard:pools.engineLoad.title")}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("dashboard:pools.engineLoad.description")}
        </p>
      </div>
      {history.isError ? (
        <InlineRetry
          message={t("dashboard:pools.engineLoad.loadFailed")}
          onRetry={() => void history.refetch()}
        />
      ) : null}
      <ul className="min-w-0 space-y-2">
        {members.map((member) => (
          <EngineLoadRow
            key={member.poolMemberId}
            member={member}
            history={byMember.get(member.poolMemberId) ?? null}
            historyPending={history.isPending}
          />
        ))}
      </ul>
    </section>
  );
}

function EngineLoadRow({
  member,
  history,
  historyPending,
}: {
  member: MemberView;
  history: HistoryView["members"][number] | null;
  historyPending: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const save = useMutation({
    ...orpc.forwarderManagement.setPoolMemberEngineLoad.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.engineLoad.saved"));
      },
      onError: (error) => {
        toast.error(friendly(error, t("dashboard:pools.engineLoad.saveFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const load = member.engineLoad;
  const inputId = `engine-load-${member.poolMemberId}`;
  const latestSource = [...(history?.series ?? [])].reverse().find((point) => !point.gap)?.source;
  const series = toSparklinePoints(history?.series ?? []);
  const hasChart = series.some((point) => !point.gap);
  return (
    <li className="min-w-0 space-y-2 border p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all font-mono text-xs">{member.upstreamModelId}</code>
        <div className="flex min-h-11 items-center gap-2">
          <Label htmlFor={inputId} className="min-h-11 cursor-pointer text-sm">
            {t("dashboard:pools.engineLoad.use")}
          </Label>
          <Switch
            id={inputId}
            checked={load.mode === "auto"}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.mutate({ poolMemberId: member.poolMemberId, mode: checked ? "auto" : "off" })
            }
          />
        </div>
      </div>
      {load.loadSource === "custom" && load.mode === "auto" ? (
        <div className="flex min-h-11 items-center gap-2">
          <Label htmlFor={`${inputId}-custom`} className="min-h-11 cursor-pointer text-sm">
            {t("dashboard:pools.engineLoad.enforceCustom")}
          </Label>
          <Switch
            id={`${inputId}-custom`}
            checked={load.customMode === "enforce"}
            disabled={save.isPending}
            onCheckedChange={(checked) =>
              save.mutate({
                poolMemberId: member.poolMemberId,
                mode: "auto",
                customMode: checked ? "enforce" : "observe",
              })
            }
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Pill tone="muted" testId="engine-load-provenance">
          {t(`dashboard:pools.engineLoad.provenance.${provenanceKey(load, latestSource)}`)}
        </Pill>
        {load.loadSource === "custom" ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.custom")}</Pill>
        ) : null}
        {load.mode === "off" ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.off")}</Pill>
        ) : !load.hasSignal ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.noSignal")}</Pill>
        ) : load.state === "stale" ? (
          <Pill tone="warn">{t("dashboard:pools.engineLoad.badges.stale")}</Pill>
        ) : !load.live ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.noReading")}</Pill>
        ) : load.full && load.enforced === false ? (
          <Pill tone="warn">{t("dashboard:pools.engineLoad.observeOnly")}</Pill>
        ) : load.full ? (
          <Pill tone="warn">{t(`dashboard:pools.engineLoad.states.${load.state}`)}</Pill>
        ) : (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.clear")}</Pill>
        )}
        {load.live ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("dashboard:pools.engineLoad.running", { count: load.live.running })}
            {typeof load.live.waiting === "number"
              ? ` · ${t("dashboard:pools.engineLoad.waiting", { count: load.live.waiting })}`
              : ""}
            {load.live.kvUsage !== null
              ? ` · ${t("dashboard:pools.engineLoad.kv", { value: percent(load.live.kvUsage) })}`
              : ""}
            {load.live.slotsBusy !== null && load.engineSlots
              ? ` · ${t("dashboard:pools.engineLoad.slots", { busy: load.live.slotsBusy, total: load.engineSlots })}`
              : ""}
            {load.live.prefixCacheQueries > 0
              ? ` · ${t("dashboard:pools.engineLoad.prefixHit", { value: percent(load.live.prefixCacheHits / load.live.prefixCacheQueries) })}`
              : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:pools.engineLoad.noReading")}
          </span>
        )}
        {load.kvBudget.active ? (
          <>
            <Pill tone="warn">{t("dashboard:pools.engineLoad.kvBudgetLowered")}</Pill>
            <span className="text-xs text-muted-foreground">
              {t("dashboard:pools.engineLoad.kvBudgetEvictions", {
                effective: load.kvBudget.effectiveTokens?.toLocaleString(),
                reported: load.kvBudget.reportedTokens?.toLocaleString(),
              })}
            </span>
          </>
        ) : null}
      </div>
      {historyPending ? (
        <Skeleton
          className="w-full"
          style={{ height: ENGINE_LOAD_SPARKLINE_HEIGHT_PX }}
          data-testid="engine-load-sparkline-skeleton"
          aria-busy="true"
        />
      ) : hasChart ? (
        <EngineLoadSparkline
          series={series}
          threshold={history?.effectiveKvFullThreshold ?? load.effectiveKvFullThreshold}
          caption={t("dashboard:pools.engineLoad.sparklineCaption")}
          labels={sparklineLabels(t)}
        />
      ) : null}
    </li>
  );
}

function sparklineLabels(t: ReturnType<typeof useTranslation>["t"]) {
  return {
    running: t("dashboard:pools.engineLoad.legendRunning"),
    waiting: t("dashboard:pools.engineLoad.legendWaiting"),
    kvUsage: t("dashboard:pools.engineLoad.legendKv"),
    kvOccupancy: t("dashboard:pools.engineLoad.legendOccupancy"),
    threshold: t("dashboard:pools.engineLoad.legendThreshold"),
  };
}

function toSparklinePoints(
  series: HistoryView["members"][number]["series"],
): EngineLoadSparklinePoint[] {
  return series.map((point) => ({
    start: point.start,
    running: point.running,
    waiting: point.waiting,
    kvUsage: point.kvUsage,
    kvOccupancy: point.kvOccupancy,
    gap: point.gap,
  }));
}

function historyRefetchInterval(): number | false {
  return typeof document !== "undefined" && document.visibilityState === "visible" ? 10_000 : false;
}

/**
 * Compact 30-minute engine-load chart on a capacity card when exactly one
 * endpoint feeds that capacity.
 */
export function CapacityEngineLoadChart({ capacityId }: { capacityId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const history = useQuery({
    ...orpc.forwarderManagement.getEngineLoadHistory.queryOptions({ input: { capacityId } }),
    refetchInterval: historyRefetchInterval,
  });
  const member = history.data?.members[0];
  const series = toSparklinePoints(member?.series ?? []);
  const hasChart = series.some((point) => !point.gap);
  if (history.isPending) {
    return (
      <Skeleton
        className="mt-2 w-full"
        style={{ height: ENGINE_LOAD_SPARKLINE_HEIGHT_PX }}
        data-testid="engine-load-sparkline-skeleton"
        aria-busy="true"
      />
    );
  }
  if (history.isError) {
    return (
      <InlineRetry
        message={t("dashboard:pools.engineLoad.loadFailed")}
        onRetry={() => void history.refetch()}
      />
    );
  }
  if (!member || !hasChart) return null;
  return (
    <div className="mt-2 min-w-0" data-testid="capacity-engine-load-chart">
      <EngineLoadSparkline
        series={series}
        threshold={member.effectiveKvFullThreshold}
        caption={t("dashboard:pools.engineLoad.sparklineCaption")}
        labels={sparklineLabels(t)}
      />
    </div>
  );
}
