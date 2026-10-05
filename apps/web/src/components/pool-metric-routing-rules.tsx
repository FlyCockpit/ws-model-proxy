import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { PoolEngineLoad } from "@/components/pool-engine-load";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

type RoutingRulesView = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["getPoolRoutingRules"]>
>;
type StoredRule = RoutingRulesView["rules"][number];
type SeriesView = RoutingRulesView["devices"][number]["series"][number];

const METRIC_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;
const OPS = [">", ">=", "<", "<="] as const;
const EFFECTS = ["full", "avoid"] as const;
const AGGREGATES = ["max", "min", "avg"] as const;
const SCOPES = ["all", "only", "except"] as const;
const RULES_MAX = 16;

type MemberOption = { poolMemberId: string; upstreamModelId: string };

type RuleRow = {
  metric: string;
  labels: string;
  aggregate: (typeof AGGREGATES)[number];
  op: (typeof OPS)[number];
  threshold: string;
  effect: (typeof EFFECTS)[number];
  scope: (typeof SCOPES)[number];
  memberId: string;
};

const OP_KEYS = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" } as const;

/** One rule read back as a sentence, so the row's effect is clear at a glance. */
function RuleSentence({ row, members }: { row: RuleRow; members: readonly MemberOption[] }) {
  const { t } = useTranslation(["dashboard"]);
  const metric = row.metric.trim();
  const threshold = row.threshold.trim();
  if (!metric || !threshold) {
    return (
      <p className="text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">
        {t("dashboard:pools.metricRules.sentence.incomplete")}
      </p>
    );
  }
  const labels = row.labels.trim();
  const member =
    members.find((entry) => entry.poolMemberId === row.memberId)?.upstreamModelId ??
    (row.memberId || t("dashboard:pools.metricRules.sentence.unchosenMember"));
  return (
    <p
      className="min-w-0 break-words text-sm font-medium sm:col-span-2 lg:col-span-3"
      data-testid="metric-rule-sentence"
    >
      {t("dashboard:pools.metricRules.sentence.when", {
        aggregate: t(`dashboard:pools.metricRules.sentence.aggregates.${row.aggregate}`),
        metric: labels ? `${metric}{${labels}}` : metric,
        op: t(`dashboard:pools.metricRules.sentence.ops.${OP_KEYS[row.op]}`),
        threshold,
        effect: t(`dashboard:pools.metricRules.sentence.effects.${row.effect}`),
        target: t(`dashboard:pools.metricRules.sentence.targets.${row.scope}`, { member }),
      })}
    </p>
  );
}

function storedScope(rule: StoredRule): RuleRow["scope"] {
  if (rule.memberId) return "only";
  if (rule.excludeMemberId) return "except";
  return "all";
}

function memberSelectOptions(members: readonly MemberOption[], selected: string): MemberOption[] {
  if (selected && !members.some((member) => member.poolMemberId === selected)) {
    return [...members, { poolMemberId: selected, upstreamModelId: selected }];
  }
  return [...members];
}

function labelsToText(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

/** `gpu=0, fan=1` → `{gpu: "0", fan: "1"}`; null when malformed. */
export function parseLabelText(text: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const labels: Record<string, string> = {};
  for (const part of trimmed.split(",")) {
    const [key, value, ...rest] = part.split("=").map((piece) => piece.trim());
    if (rest.length > 0 || !key || value === undefined) return null;
    if (!METRIC_NAME.test(key) || !METRIC_NAME.test(value)) return null;
    // `labels.__proto__ = "x"` would set nothing and silently widen the rule;
    // the server rejects this key too.
    if (key === "__proto__") return null;
    labels[key] = value;
  }
  return Object.keys(labels).length <= 16 ? labels : null;
}

function seriesLabel(series: Pick<SeriesView, "name" | "labels">): string {
  const labels = Object.entries(series.labels);
  if (labels.length === 0) return series.name;
  return `${series.name}{${labels.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

function Pill({ children, tone }: { children: ReactNode; tone: "info" | "warn" | "muted" }) {
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center border px-2 text-xs font-medium",
        tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : tone === "info"
            ? "border-primary/20 bg-primary/10 text-primary"
            : "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Pool routing tab: metric routing rules (S-B part 2). */
export function PoolMetricRoutingRules({ poolId }: { poolId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const view = useQuery({
    ...orpc.forwarderManagement.getPoolRoutingRules.queryOptions({ input: { poolId } }),
    refetchInterval: 15_000,
  });
  if (view.isPending) {
    return (
      <div aria-busy="true" className="space-y-3" data-testid="metric-rules-skeleton">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (view.isError) {
    return (
      <InlineRetry message={t("dashboard:pools.metricRules.loadFailed")} onRetry={view.refetch} />
    );
  }
  return (
    <section className="min-w-0 space-y-6" aria-labelledby="pool-metric-rules-title">
      <div>
        <h3 id="pool-metric-rules-title" className="text-base font-semibold">
          {t("dashboard:pools.metricRules.title")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("dashboard:pools.metricRules.description")}
        </p>
      </div>
      <MetricRulesEditor
        key={JSON.stringify(view.data.rules)}
        poolId={poolId}
        rules={view.data.rules}
        members={view.data.members.map((member) => ({
          poolMemberId: member.poolMemberId,
          upstreamModelId: member.upstreamModelId,
        }))}
        metricNames={[
          ...new Set([
            ...view.data.devices.flatMap((device) => device.series.map((series) => series.name)),
            ...view.data.members.flatMap((member) =>
              member.endpointSeries.map((series) => series.name),
            ),
          ]),
        ].sort()}
      />
      <PoolEngineLoad poolId={poolId} members={view.data.members} />
      <MemberVerdicts view={view.data} />
      <DeviceSeries view={view.data} />
    </section>
  );
}

function MetricRulesEditor({
  poolId,
  rules,
  members,
  metricNames,
}: {
  poolId: string;
  rules: StoredRule[];
  members: MemberOption[];
  metricNames: string[];
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const save = useMutation({
    ...orpc.forwarderManagement.setPoolRoutingRules.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.metricRules.saved"));
      },
      onError: (error) => {
        toast.error(friendly(error, t("dashboard:pools.metricRules.saveFailed")));
      },
    }),
    meta: { skipGlobalErrorToast: true },
  });
  const rowSchema = z
    .object({
      metric: z.string().trim().regex(METRIC_NAME, t("dashboard:pools.metricRules.metricInvalid")),
      labels: z
        .string()
        .refine(
          (value) => parseLabelText(value) !== null,
          t("dashboard:pools.metricRules.labelsInvalid"),
        ),
      aggregate: z.enum(AGGREGATES),
      op: z.enum(OPS),
      threshold: z
        .string()
        .trim()
        .refine(
          (value) => value !== "" && Number.isFinite(Number(value)),
          t("dashboard:pools.metricRules.thresholdInvalid"),
        ),
      effect: z.enum(EFFECTS),
      scope: z.enum(SCOPES),
      memberId: z.string(),
    })
    .superRefine((row, context) => {
      if (row.scope !== "all" && row.memberId.trim() === "") {
        context.addIssue({
          code: "custom",
          path: ["memberId"],
          message: t("dashboard:pools.metricRules.memberRequired"),
        });
      }
    });
  const form = useForm({
    defaultValues: {
      rules: rules.map(
        (rule): RuleRow => ({
          metric: rule.metric,
          labels: labelsToText(rule.labels),
          aggregate: rule.aggregate,
          op: rule.op,
          threshold: String(rule.threshold),
          effect: rule.effect,
          scope: storedScope(rule),
          memberId: rule.memberId ?? rule.excludeMemberId ?? "",
        }),
      ),
    },
    validators: { onSubmit: z.object({ rules: z.array(rowSchema).max(RULES_MAX) }) },
    onSubmit: async ({ value }) => {
      await save
        .mutateAsync({
          poolId,
          rules: value.rules.map((row) => {
            const labels = parseLabelText(row.labels) ?? {};
            const memberId = row.memberId.trim();
            return {
              metric: row.metric.trim(),
              ...(Object.keys(labels).length > 0 ? { labels } : {}),
              aggregate: row.aggregate,
              op: row.op,
              threshold: Number(row.threshold),
              effect: row.effect,
              ...(row.scope === "only" && memberId ? { memberId } : {}),
              ...(row.scope === "except" && memberId ? { excludeMemberId: memberId } : {}),
            };
          }),
        })
        .catch(() => undefined);
    },
  });
  const datalistId = `metric-names-${poolId}`;
  return (
    <form
      className="min-w-0 space-y-3 rounded-md border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <datalist id={datalistId}>
        {metricNames.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <p className="text-xs text-muted-foreground">{t("dashboard:pools.metricRules.hint")}</p>
      <form.Field name="rules" mode="array">
        {(field) => (
          <div className="space-y-3">
            {field.state.value.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("dashboard:pools.metricRules.empty")}
              </p>
            ) : null}
            {field.state.value.map((_, index) => (
              <fieldset
                // Rows have no identity beyond their position in the list.
                key={index}
                className="grid min-w-0 gap-2 border p-3 sm:grid-cols-2 lg:grid-cols-3"
              >
                <legend className="sr-only">
                  {t("dashboard:pools.metricRules.ruleLegend", { number: index + 1 })}
                </legend>
                <form.Subscribe selector={(state) => state.values.rules[index]}>
                  {(row) => (row ? <RuleSentence row={row} members={members} /> : null)}
                </form.Subscribe>
                <form.Field name={`rules[${index}].metric`}>
                  {(sub) => (
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${datalistId}-metric-${index}`}>
                        {t("dashboard:pools.metricRules.metric")}
                      </Label>
                      <Input
                        id={`${datalistId}-metric-${index}`}
                        className="min-h-11"
                        list={datalistId}
                        value={sub.state.value}
                        onBlur={sub.handleBlur}
                        onChange={(event) => sub.handleChange(event.target.value)}
                      />
                      {sub.state.meta.errors.map((error) => (
                        <p key={error?.message} className="text-sm text-destructive">
                          {error?.message}
                        </p>
                      ))}
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].labels`}>
                  {(sub) => (
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${datalistId}-labels-${index}`}>
                        {t("dashboard:pools.metricRules.labels")}
                      </Label>
                      <Input
                        id={`${datalistId}-labels-${index}`}
                        className="min-h-11"
                        placeholder="gpu=0"
                        value={sub.state.value}
                        onBlur={sub.handleBlur}
                        onChange={(event) => sub.handleChange(event.target.value)}
                      />
                      {sub.state.meta.errors.map((error) => (
                        <p key={error?.message} className="text-sm text-destructive">
                          {error?.message}
                        </p>
                      ))}
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].aggregate`}>
                  {(sub) => (
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${datalistId}-aggregate-${index}`}>
                        {t("dashboard:pools.metricRules.aggregate")}
                      </Label>
                      <select
                        id={`${datalistId}-aggregate-${index}`}
                        className="min-h-11 w-full rounded-md border bg-background px-3"
                        value={sub.state.value}
                        onChange={(event) =>
                          sub.handleChange(event.target.value as (typeof AGGREGATES)[number])
                        }
                      >
                        {AGGREGATES.map((aggregate) => (
                          <option key={aggregate} value={aggregate}>
                            {t(`dashboard:pools.metricRules.aggregates.${aggregate}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].op`}>
                  {(sub) => (
                    <div className="space-y-1">
                      <Label htmlFor={`${datalistId}-op-${index}`}>
                        {t("dashboard:pools.metricRules.op")}
                      </Label>
                      <select
                        id={`${datalistId}-op-${index}`}
                        className="min-h-11 w-full rounded-md border bg-background px-3"
                        value={sub.state.value}
                        onChange={(event) =>
                          sub.handleChange(event.target.value as (typeof OPS)[number])
                        }
                      >
                        {OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].threshold`}>
                  {(sub) => (
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${datalistId}-threshold-${index}`}>
                        {t("dashboard:pools.metricRules.threshold")}
                      </Label>
                      <Input
                        id={`${datalistId}-threshold-${index}`}
                        className="min-h-11"
                        inputMode="decimal"
                        value={sub.state.value}
                        onBlur={sub.handleBlur}
                        onChange={(event) => sub.handleChange(event.target.value)}
                      />
                      {sub.state.meta.errors.map((error) => (
                        <p key={error?.message} className="text-sm text-destructive">
                          {error?.message}
                        </p>
                      ))}
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].effect`}>
                  {(sub) => (
                    <div className="space-y-1">
                      <Label htmlFor={`${datalistId}-effect-${index}`}>
                        {t("dashboard:pools.metricRules.effect")}
                      </Label>
                      <select
                        id={`${datalistId}-effect-${index}`}
                        className="min-h-11 w-full rounded-md border bg-background px-3"
                        value={sub.state.value}
                        onChange={(event) =>
                          sub.handleChange(event.target.value as (typeof EFFECTS)[number])
                        }
                      >
                        {EFFECTS.map((effect) => (
                          <option key={effect} value={effect}>
                            {t(`dashboard:pools.metricRules.effects.${effect}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </form.Field>
                <form.Field name={`rules[${index}].scope`}>
                  {(sub) => (
                    <div className="min-w-0 space-y-1">
                      <Label htmlFor={`${datalistId}-scope-${index}`}>
                        {t("dashboard:pools.metricRules.scope")}
                      </Label>
                      <select
                        id={`${datalistId}-scope-${index}`}
                        className="min-h-11 w-full rounded-md border bg-background px-3"
                        value={sub.state.value}
                        onChange={(event) =>
                          sub.handleChange(event.target.value as (typeof SCOPES)[number])
                        }
                      >
                        {SCOPES.map((scope) => (
                          <option key={scope} value={scope}>
                            {t(`dashboard:pools.metricRules.scopes.${scope}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </form.Field>
                <form.Subscribe selector={(state) => state.values.rules[index]?.scope}>
                  {(scope) =>
                    scope === "all" ? null : (
                      <form.Field name={`rules[${index}].memberId`}>
                        {(sub) => (
                          <div className="min-w-0 space-y-1">
                            <Label htmlFor={`${datalistId}-member-${index}`}>
                              {t("dashboard:pools.metricRules.member")}
                            </Label>
                            <select
                              id={`${datalistId}-member-${index}`}
                              className="min-h-11 w-full rounded-md border bg-background px-3"
                              value={sub.state.value}
                              onChange={(event) => sub.handleChange(event.target.value)}
                            >
                              <option value="">
                                {t("dashboard:pools.metricRules.memberPlaceholder")}
                              </option>
                              {memberSelectOptions(members, sub.state.value).map((member) => (
                                <option key={member.poolMemberId} value={member.poolMemberId}>
                                  {member.upstreamModelId}
                                </option>
                              ))}
                            </select>
                            {sub.state.meta.errors.map((error) => (
                              <p key={error?.message} className="text-sm text-destructive">
                                {error?.message}
                              </p>
                            ))}
                          </div>
                        )}
                      </form.Field>
                    )
                  }
                </form.Subscribe>
                <div className="flex items-end">
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    aria-label={t("dashboard:pools.metricRules.remove", { number: index + 1 })}
                    onClick={() => field.removeValue(index)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </fieldset>
            ))}
            <Button
              type="button"
              size="touch"
              variant="outline"
              disabled={field.state.value.length >= RULES_MAX}
              onClick={() =>
                field.pushValue({
                  metric: "",
                  labels: "",
                  aggregate: "max",
                  op: ">",
                  threshold: "",
                  effect: "full",
                  scope: "all",
                  memberId: "",
                })
              }
            >
              <Plus className="size-4" />
              {t("dashboard:pools.metricRules.add")}
            </Button>
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" disabled={isSubmitting || save.isPending}>
            {t("dashboard:pools.metricRules.save")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function MemberVerdicts({ view }: { view: RoutingRulesView }) {
  const { t } = useTranslation(["dashboard"]);
  if (view.rules.length === 0 || view.members.length === 0) return null;
  return (
    <section className="space-y-2" aria-labelledby="pool-metric-verdicts-title">
      <h4 id="pool-metric-verdicts-title" className="text-sm font-semibold">
        {t("dashboard:pools.metricRules.membersTitle")}
      </h4>
      <ul className="space-y-2">
        {view.members.map((member) => {
          const staleRules = member.ruleStates.filter((state) => state === "stale").length;
          return (
            <li
              key={member.poolMemberId}
              className="flex min-w-0 flex-wrap items-center justify-between gap-2 border p-3"
            >
              <code className="min-w-0 break-all font-mono text-xs">{member.upstreamModelId}</code>
              <div className="flex flex-wrap gap-2">
                {member.state === "active" && member.verdict === "full" ? (
                  <Pill tone="warn">{t("dashboard:pools.metricRules.badges.full")}</Pill>
                ) : null}
                {member.state === "active" && member.verdict === "avoid" ? (
                  <Pill tone="info">{t("dashboard:pools.metricRules.badges.avoid")}</Pill>
                ) : null}
                {member.state === "active" && member.verdict === "none" ? (
                  <Pill tone="muted">{t("dashboard:pools.metricRules.badges.clear")}</Pill>
                ) : null}
                {member.state === "stale" ? (
                  <Pill tone="warn">{t("dashboard:pools.metricRules.badges.stale")}</Pill>
                ) : null}
                {member.state === "unevaluated" ? (
                  <Pill tone="muted">{t("dashboard:pools.metricRules.badges.unevaluated")}</Pill>
                ) : null}
                {member.state === "active" && staleRules > 0 ? (
                  <Pill tone="warn">
                    {t("dashboard:pools.metricRules.badges.rulesStale", { count: staleRules })}
                  </Pill>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function DeviceSeries({ view }: { view: RoutingRulesView }) {
  const { t } = useTranslation(["dashboard"]);
  if (view.devices.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="pool-metric-series-title">
      <div>
        <h4 id="pool-metric-series-title" className="text-sm font-semibold">
          {t("dashboard:pools.metricRules.seriesTitle")}
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("dashboard:pools.metricRules.seriesHint")}
        </p>
      </div>
      {view.devices.map((device) => (
        <div key={device.cliDeviceId} className="min-w-0 space-y-2 border p-3">
          <p className="break-words text-sm font-medium">
            {device.label}
            {device.live ? null : (
              <span className="ml-2 text-xs text-muted-foreground">
                {t("dashboard:pools.metricRules.offline")}
              </span>
            )}
          </p>
          {device.series.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("dashboard:pools.metricRules.noSeries")}
            </p>
          ) : (
            <ul className="space-y-1">
              {device.series.map((series) => (
                <li
                  key={seriesLabel(series)}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 text-xs"
                >
                  <code className="min-w-0 break-all font-mono">{seriesLabel(series)}</code>
                  <span
                    className={cn(
                      "tabular-nums",
                      series.stale ? "text-amber-700 dark:text-amber-300" : "",
                    )}
                  >
                    {series.value.toLocaleString()}
                    {series.stale ? ` · ${t("dashboard:pools.metricRules.staleValue")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
