import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

type RoutingRulesView = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["getPoolRoutingRules"]>
>;
type MemberView = RoutingRulesView["members"][number];

function Pill({ children, tone }: { children: ReactNode; tone: "warn" | "muted" }) {
  return (
    <span
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

/**
 * Per-member live engine load (S-D): running/waiting/KV %, a stale badge and
 * the "use engine load" override. Engine load only adds FULL; lease counts
 * stay authoritative. Active prefix-eviction cuts explain the effective KV budget.
 */
export function PoolEngineLoad({ members }: { members: MemberView[] }) {
  const { t } = useTranslation(["dashboard"]);
  if (members.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="pool-engine-load-title">
      <div>
        <h4 id="pool-engine-load-title" className="text-sm font-semibold">
          {t("dashboard:pools.engineLoad.title")}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("dashboard:pools.engineLoad.description")}
        </p>
      </div>
      <ul className="space-y-2">
        {members.map((member) => (
          <EngineLoadRow key={member.poolMemberId} member={member} />
        ))}
      </ul>
    </section>
  );
}

function EngineLoadRow({ member }: { member: MemberView }) {
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
      <div className="flex flex-wrap items-center gap-2">
        {load.mode === "off" ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.off")}</Pill>
        ) : !load.hasSignal ? (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.noSignal")}</Pill>
        ) : load.state === "stale" ? (
          <Pill tone="warn">{t("dashboard:pools.engineLoad.badges.stale")}</Pill>
        ) : load.full ? (
          <Pill tone="warn">{t(`dashboard:pools.engineLoad.states.${load.state}`)}</Pill>
        ) : (
          <Pill tone="muted">{t("dashboard:pools.engineLoad.badges.clear")}</Pill>
        )}
        {load.live ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {t("dashboard:pools.engineLoad.running", { count: load.live.running })}
            {" · "}
            {t("dashboard:pools.engineLoad.waiting", { count: load.live.waiting })}
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
    </li>
  );
}
