import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  POOL_ADVANCED_COLUMNS,
  POOL_ADVANCED_OVERRIDES,
  type RegistryEntry,
} from "@ws-model-proxy/config/pool-defaults";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/advanced")({
  component: PoolAdvancedPage,
});

type Group = "columns" | "affinity" | "protection" | "flat";
type Effective = { effective: number | boolean | string | null; source: string };
type Value = number | boolean | string | null;

const { affinity, protection, ...flat } = POOL_ADVANCED_OVERRIDES;
const SECTIONS: ReadonlyArray<{ group: Group; entries: Record<string, RegistryEntry> }> = [
  { group: "columns", entries: POOL_ADVANCED_COLUMNS },
  { group: "flat", entries: flat as Record<string, RegistryEntry> },
  { group: "affinity", entries: affinity },
  { group: "protection", entries: protection },
];

/** The `pools.update` advanced patch for one key (null = back to automatic). */
function patchFor(group: Group, key: string, value: Value) {
  if (group === "columns") return { [key]: value };
  if (group === "flat") return { overrides: { [key]: value } };
  return { overrides: { [group]: { [key]: value } } };
}

function viewFor(pool: PoolView, group: Group, key: string): Effective | undefined {
  const advanced = pool.advanced as unknown as Record<string, unknown>;
  const holder = group === "affinity" || group === "protection" ? advanced[group] : advanced;
  return (holder as Record<string, Effective> | undefined)?.[key];
}

function PoolAdvancedPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  if (pool.isPending) return <Skeleton className="h-96 w-full rounded-xl" aria-hidden="true" />;
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("dashboard:pool.advanced.intro")}</p>
      {SECTIONS.map((section) => (
        <Card key={section.group}>
          <CardHeader>
            <CardTitle className="text-base">
              {t(`dashboard:pool.advanced.sections.${section.group}`)}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col divide-y">
            {Object.entries(section.entries).map(([key, entry]) => (
              <AdvancedRow
                key={key}
                pool={pool.data}
                group={section.group}
                name={key}
                entry={entry}
                view={viewFor(pool.data, section.group, key)}
              />
            ))}
          </CardContent>
        </Card>
      ))}
      <RulesCard pool={pool.data} />
    </div>
  );
}

function AdvancedRow({
  pool,
  group,
  name,
  entry,
  view,
}: {
  pool: PoolView;
  group: Group;
  name: string;
  entry: RegistryEntry;
  view: Effective | undefined;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const labelKey = group === "affinity" || group === "protection" ? `${group}.${name}` : name;
  const id = `advanced-${group}-${name}`;
  const [draft, setDraft] = useState<string>(
    view?.source === "override" && view.effective !== null ? String(view.effective) : "",
  );
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const save = async (value: Value) => {
    try {
      await update.mutateAsync({ poolId: pool.id, advanced: patchFor(group, name, value) });
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      toast.success(t("dashboard:pool.saved"));
      if (value === null) setDraft("");
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const parsed = (): Value | undefined => {
    if (entry.kind === "bool")
      return draft === "true" ? true : draft === "false" ? false : undefined;
    if (entry.kind === "enum") return entry.values.includes(draft) ? draft : undefined;
    const number = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(number)) return undefined;
    if (entry.kind === "int" && !Number.isInteger(number)) return undefined;
    return number >= entry.min && number <= entry.max ? number : undefined;
  };
  const next = parsed();
  return (
    <form
      className="flex min-w-0 flex-col gap-2 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (next !== undefined) save(next);
      }}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Label htmlFor={id} className="font-medium">
          {t(`dashboard:pool.advanced.keys.${labelKey}`)}
        </Label>
        <StatusPill tone={view?.source === "override" ? "info" : "muted"}>
          {t(`dashboard:pool.advanced.source.${view?.source ?? "default"}`)}
        </StatusPill>
        <span className="text-sm text-muted-foreground">
          {view?.effective === null || view?.effective === undefined
            ? t("dashboard:pool.advanced.unknown")
            : String(view.effective)}
          {"unit" in entry && entry.unit
            ? ` ${t(`dashboard:pool.advanced.units.${entry.unit}`)}`
            : ""}
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        {entry.kind === "bool" || entry.kind === "enum" ? (
          <NativeSelect
            id={id}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="sm:max-w-xs"
          >
            <option value="">{t("dashboard:pool.advanced.pick")}</option>
            {(entry.kind === "bool" ? ["true", "false"] : entry.values).map((value) => (
              <option key={value} value={value}>
                {entry.kind === "bool" ? t(`dashboard:pool.advanced.bool.${value}`) : value}
              </option>
            ))}
          </NativeSelect>
        ) : (
          <Input
            id={id}
            inputMode={entry.kind === "int" ? "numeric" : "decimal"}
            className="h-11 sm:max-w-xs"
            placeholder={`${entry.min} – ${entry.max}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        )}
        <Button type="submit" size="touch" disabled={next === undefined || update.isPending}>
          {t("dashboard:pool.advanced.override")}
        </Button>
        {view?.source === "override" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={update.isPending}
            onClick={() => save(null)}
          >
            {t("dashboard:pool.advanced.automatic")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function RulesCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const remove = useMutation({
    ...orpc.pools.rules.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.advanced.rules")}</CardTitle>
        <CardDescription>{t("dashboard:pool.advanced.rulesHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        {pool.rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:pool.advanced.noRules")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {pool.rules.map((rule) => {
              const text = `${rule.rule.aggregate}(${rule.rule.metric}) ${rule.rule.op} ${rule.rule.threshold} → ${rule.rule.effect}`;
              return (
                <li key={rule.id} className="flex min-w-0 items-center gap-2 py-2">
                  <code className="min-w-0 flex-1 break-all font-mono text-sm">{text}</code>
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:pool.advanced.deleteRule", { rule: text })}
                    disabled={remove.isPending}
                    onClick={async () => {
                      try {
                        await remove.mutateAsync({ ruleId: rule.id });
                        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
                      } catch (error) {
                        toast.error(refusalText(error));
                      }
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
