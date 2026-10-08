import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { RegistryOverrideRow } from "@/components/registry-override-row";
import type { PoolView } from "@/lib/pool-ui";
import { refusalReason, refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN } from "@/lib/slugify";
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
      <DangerZone pool={pool.data} />
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
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <RegistryOverrideRow
      id={`advanced-${group}-${name}`}
      label={t(`dashboard:pool.advanced.keys.${labelKey}`)}
      entry={entry}
      view={view}
      pending={update.isPending}
      onSave={async (value) => {
        try {
          await update.mutateAsync({ poolId: pool.id, advanced: patchFor(group, name, value) });
          await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
          toast.success(t("dashboard:pool.saved"));
          return true;
        } catch (error) {
          toast.error(refusalText(error));
          return false;
        }
      }}
    />
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

// ── Danger zone ──

function DangerZone({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [dialog, setDialog] = useState<"slug" | "delete" | null>(null);
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert aria-hidden="true" className="size-4 text-destructive" />
          {t("dashboard:pool.danger.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col divide-y">
        <div className="flex min-w-0 flex-wrap items-center gap-3 pb-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("dashboard:pool.danger.slug")}</p>
            <p className="text-sm text-muted-foreground">
              {t("dashboard:pool.danger.slugHint", { id: pool.callableIds[0] ?? pool.slug })}
            </p>
          </div>
          <Button variant="outline" size="touch" onClick={() => setDialog("slug")}>
            {t("dashboard:pool.danger.slugButton")}
          </Button>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 pt-4">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm font-medium">{t("dashboard:pool.delete")}</p>
            <p className="text-sm text-muted-foreground">{t("dashboard:pool.deleteHint")}</p>
          </div>
          <Button variant="destructive" size="touch" onClick={() => setDialog("delete")}>
            {t("dashboard:pool.delete")}
          </Button>
        </div>
      </CardContent>
      {/* Mounted per opening, so each starts empty. */}
      {dialog === "slug" ? <ChangeSlugDialog pool={pool} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? (
        <DeletePoolDialog pool={pool} onClose={() => setDialog(null)} />
      ) : null}
    </Card>
  );
}

function ChangeSlugDialog({ pool, onClose }: { pool: PoolView; onClose: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { slug: "", confirm: "" },
    validators: {
      onSubmit: z
        .object({
          slug: z
            .string()
            .trim()
            .regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid"))
            .refine((slug) => slug !== pool.slug, t("dashboard:pool.danger.slugSame")),
          confirm: z.string(),
        })
        .refine((value) => value.confirm.trim() === value.slug.trim(), {
          message: t("dashboard:pool.danger.slugConfirmMismatch"),
          path: ["confirm"],
        }),
    },
    onSubmit: async ({ value }) => {
      try {
        await update.mutateAsync({ poolId: pool.id, slug: value.slug.trim() });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
        toast.success(t("dashboard:pool.danger.slugChanged"));
        onClose();
      } catch (error) {
        toast.error(
          refusalReason(error) === "alias_shadowed"
            ? t("dashboard:pool.danger.slugAliased")
            : refusalText(error),
        );
      }
    },
  });
  const owner = pool.owner.slug;
  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("dashboard:pool.danger.slugTitle")}
      description={t("dashboard:pool.danger.slugWarning", { id: `${owner}/${pool.slug}` })}
    >
      <form
        className="flex flex-col gap-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.Field name="slug">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-new-slug">{t("dashboard:pool.danger.newSlug")}</Label>
              <Input
                id="pool-new-slug"
                className="h-11 font-mono"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <form.Subscribe selector={(state) => state.values.slug.trim()}>
                {(slug) =>
                  slug ? (
                    <p className="break-all text-xs text-muted-foreground">
                      {t("dashboard:pool.danger.newId", { id: `${owner}/${slug}` })}
                    </p>
                  ) : null
                }
              </form.Subscribe>
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="confirm">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-new-slug-confirm">
                {t("dashboard:pool.danger.slugConfirm")}
              </Label>
              <Input
                id="pool-new-slug-confirm"
                className="h-11 font-mono"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" size="touch" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <form.Subscribe
            selector={(state) =>
              [
                state.isSubmitting,
                state.values.slug.trim() !== "" &&
                  state.values.confirm.trim() === state.values.slug.trim(),
              ] as const
            }
          >
            {([submitting, typed]) => (
              <Button
                type="submit"
                variant="destructive"
                size="touch"
                disabled={submitting || !typed}
              >
                {submitting ? t("common:actions.saving") : t("dashboard:pool.danger.slugButton")}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </form>
    </ResponsiveDialog>
  );
}

function DeletePoolDialog({ pool, onClose }: { pool: PoolView; onClose: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    ...orpc.pools.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("dashboard:pool.deleteTitle", { name: pool.name })}
      description={t("dashboard:pool.deleteHint")}
      footer={
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" size="touch" onClick={onClose}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="destructive"
            size="touch"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync({ poolId: pool.id });
                onClose();
                // Leave first: the deleted pool's own query must not refetch.
                await navigate({ to: "/$lang/pools", params: { lang } });
                await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
                await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
                await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
              } catch (error) {
                toast.error(refusalText(error));
              }
            }}
          >
            {remove.isPending ? t("common:actions.deleting") : t("common:actions.delete")}
          </Button>
        </div>
      }
    >
      <span />
    </ResponsiveDialog>
  );
}
