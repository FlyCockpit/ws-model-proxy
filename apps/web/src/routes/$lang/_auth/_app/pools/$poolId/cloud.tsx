import { useForm } from "@tanstack/react-form";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
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
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import { TimeAgo } from "@/components/time-ago";
import { formatMs } from "@/lib/format-metrics";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/cloud")({
  component: PoolCloudPage,
});

const MODES = ["OFF", "OWNER", "OWNER_AND_SHARES"] as const;

function PoolCloudPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  if (pool.isPending) return <Skeleton className="h-64 w-full rounded-xl" aria-hidden="true" />;
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return <CloudSettings pool={pool.data} />;
}

function CloudSettings({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const queryClient = useQueryClient();
  const setMode = useMutation({
    ...orpc.pools.cloud.setMode.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const setWarm = useMutation({
    ...orpc.pools.cloud.setPaidWarmProtection.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      toast.success(t("dashboard:pool.saved"));
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };
  const cloudMembers = pool.members
    .filter((member) => member.kind === "CLOUD")
    .sort((a, b) => (a.cloudOrder ?? 0) - (b.cloudOrder ?? 0));
  /** The cloud list with the member at `index` moved by `delta` (pools.update replaces it). */
  const moved = (index: number, delta: -1 | 1) => {
    const order = [...cloudMembers];
    const [member] = order.splice(index, 1);
    if (member) order.splice(index + delta, 0, member);
    return order.flatMap((other) =>
      other.providerModelId ? [{ providerModelId: other.providerModelId }] : [],
    );
  };
  const providerModels = useQuery(orpc.providers.models.list.queryOptions({ input: {} }));
  const [choice, setChoice] = useState("");
  const updatePool = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const inUse = new Set(cloudMembers.map((member) => member.providerModelId));
  /** Members whose provider model was turned off or removed: every list write refuses them. */
  const enabledIds = new Set(
    (providerModels.data?.models ?? []).filter((model) => model.enabled).map((model) => model.id),
  );
  const stale = (member: PoolView["members"][number]) =>
    providerModels.isSuccess && !enabledIds.has(member.providerModelId ?? "");
  const candidates = (providerModels.data?.models ?? []).filter(
    (model) => model.enabled && model.type === pool.modelType && !inUse.has(model.id),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.cloud.title")}</CardTitle>
          <CardDescription>{t("dashboard:pool.cloud.hint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cloud-mode">{t("dashboard:pool.cloud.mode")}</Label>
            <NativeSelect
              id="cloud-mode"
              value={pool.cloud.mode}
              disabled={setMode.isPending}
              onChange={(event) =>
                run(() =>
                  setMode.mutateAsync({
                    poolId: pool.id,
                    mode: event.target.value as (typeof MODES)[number],
                  }),
                )
              }
            >
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`dashboard:pool.cloud.modes.${mode}`)}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("dashboard:pool.cloud.humanOnly")}</p>
          </div>
          <div className="flex min-h-11 items-center gap-3">
            <Switch
              id="cloud-warm"
              checked={pool.cloud.paidWarmProtection}
              disabled={setWarm.isPending}
              onCheckedChange={(checked) =>
                run(() => setWarm.mutateAsync({ poolId: pool.id, enabled: checked === true }))
              }
            />
            <Label htmlFor="cloud-warm">{t("dashboard:pool.cloud.paidWarm")}</Label>
          </div>
          <ExternalNote pool={pool} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.cloud.members")}</CardTitle>
          <CardDescription>
            {t("dashboard:pool.cloud.membersHint")}{" "}
            <Link to="/$lang/providers" params={{ lang }} className="underline underline-offset-4">
              {t("dashboard:providers.title")}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cloudMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pool.cloud.noMembers")}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {cloudMembers.map((member, index) => (
                <li key={member.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{index + 1}.</span>
                  <span className="min-w-0 flex-1 break-all font-mono text-sm">
                    {member.upstreamModelId}
                  </span>
                  {stale(member) ? (
                    <StatusPill tone="bad">{t("dashboard:pool.cloud.notEnabled")}</StatusPill>
                  ) : (
                    <StatusPill tone="info">
                      {t(`dashboard:pool.memberStatus.${member.status}`)}
                    </StatusPill>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:pool.cloud.moveUp", {
                      member: member.upstreamModelId,
                    })}
                    disabled={updatePool.isPending || index === 0}
                    onClick={() =>
                      run(() =>
                        updatePool.mutateAsync({ poolId: pool.id, cloudMembers: moved(index, -1) }),
                      )
                    }
                  >
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:pool.cloud.moveDown", {
                      member: member.upstreamModelId,
                    })}
                    disabled={updatePool.isPending || index === cloudMembers.length - 1}
                    onClick={() =>
                      run(() =>
                        updatePool.mutateAsync({ poolId: pool.id, cloudMembers: moved(index, 1) }),
                      )
                    }
                  >
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:pool.removeMember", {
                      member: member.upstreamModelId,
                    })}
                    disabled={updatePool.isPending}
                    onClick={() =>
                      run(() =>
                        updatePool.mutateAsync({
                          poolId: pool.id,
                          cloudMembers: cloudMembers
                            .filter((other) => other.id !== member.id)
                            .flatMap((other) =>
                              other.providerModelId
                                ? [{ providerModelId: other.providerModelId }]
                                : [],
                            ),
                        }),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <form
            className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice) return;
              run(() =>
                updatePool.mutateAsync({
                  poolId: pool.id,
                  cloudMembers: [
                    ...cloudMembers.flatMap((member) =>
                      member.providerModelId ? [{ providerModelId: member.providerModelId }] : [],
                    ),
                    { providerModelId: choice },
                  ],
                }),
              ).then((ok) => {
                if (ok) setChoice("");
              });
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="cloud-add">{t("dashboard:pool.cloud.add")}</Label>
              {providerModels.isPending ? (
                <Skeleton className="h-11 w-full" />
              ) : providerModels.isError ? (
                <InlineRetry onRetry={() => providerModels.refetch()} />
              ) : (
                <NativeSelect
                  id="cloud-add"
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">{t("dashboard:pool.cloud.pickModel")}</option>
                  {candidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName ?? model.upstreamModelId}
                    </option>
                  ))}
                </NativeSelect>
              )}
              {providerModels.isSuccess && candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pool.cloud.noCandidates")}
                </p>
              ) : null}
            </div>
            <Button
              type="submit"
              size="touch"
              disabled={!choice || updatePool.isPending || cloudMembers.length >= 16}
            >
              {t("dashboard:pool.add")}
            </Button>
          </form>
        </CardContent>
      </Card>
      {pool.modelType === "EMBEDDINGS" ? <EmbeddingContractCard pool={pool} /> : null}
      <OwnKeyCard pool={pool} />
      <HistoryCard poolId={pool.id} />
    </div>
  );
}

/** `:external` falls back to the cloud when the pool's one max wait runs out (set on Advanced). */
function ExternalNote({ pool }: { pool: PoolView }) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const { lang } = Route.useParams();
  const view = pool.advanced.maxWaitMs;
  const value =
    typeof view.effective === "number"
      ? formatMs(view.effective, i18n.language, t("dashboard:overview.kpi.none"))
      : t("dashboard:pool.advanced.unknown");
  return (
    <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
      {t(
        pool.cloud.mode === "OFF"
          ? "dashboard:pool.cloud.externalNoteOff"
          : "dashboard:pool.cloud.externalNote",
        { id: `${pool.owner.slug}/${pool.slug}:external` },
      )}{" "}
      <span className="font-medium text-foreground">
        {t("dashboard:pool.cloud.maxWait", {
          value,
          source: t(`dashboard:pool.advanced.source.${view.source}`, {
            defaultValue: view.source,
          }),
        })}
      </span>{" "}
      <Link
        to="/$lang/pools/$poolId/advanced"
        params={{ lang, poolId: pool.id }}
        className="inline-flex min-h-11 items-center underline underline-offset-4"
      >
        {t("dashboard:pool.cloud.setOnAdvanced")}
      </Link>
    </p>
  );
}

function usePoolSaved() {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  return async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      toast.success(t("dashboard:pool.saved"));
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };
}

const NORMALIZATIONS = ["none", "l2"] as const;

function EmbeddingContractCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const save = usePoolSaved();
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const current = pool.cloud.embeddingContract;
  const text = (max: number) =>
    z.string().trim().min(1, t("dashboard:pool.contract.required")).max(max);
  const form = useForm({
    defaultValues: {
      model: current?.model ?? "",
      revision: current?.revision ?? "",
      dimensions: current ? String(current.dimensions) : "",
      normalization: (current?.normalization ?? "none") as (typeof NORMALIZATIONS)[number],
      vectorSpace: current?.vectorSpace ?? "",
    },
    validators: {
      onSubmit: z.object({
        model: text(256),
        revision: text(256),
        dimensions: z
          .string()
          .trim()
          .regex(/^[1-9]\d{0,6}$/, t("dashboard:pool.contract.dimensionsInvalid"))
          .refine(
            (value) => Number(value) <= 1_000_000,
            t("dashboard:pool.contract.dimensionsInvalid"),
          ),
        normalization: z.enum(NORMALIZATIONS),
        vectorSpace: text(256),
      }),
    },
    onSubmit: async ({ value }) => {
      await save(() =>
        update.mutateAsync({
          poolId: pool.id,
          cloud: {
            embeddingContract: {
              model: value.model.trim(),
              revision: value.revision.trim(),
              dimensions: Number(value.dimensions.trim()),
              normalization: value.normalization,
              vectorSpace: value.vectorSpace.trim(),
            },
          },
        }),
      );
    },
  });
  const textFields = [
    { name: "model", placeholder: "BAAI/bge-m3" },
    { name: "revision", placeholder: "main" },
    { name: "dimensions", placeholder: "1024" },
    { name: "vectorSpace", placeholder: "bge-m3-dense" },
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.contract.title")}</CardTitle>
        <CardDescription>{t("dashboard:pool.contract.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex min-w-0 flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {textFields.map(({ name, placeholder }) => (
              <form.Field key={name} name={name}>
                {(field) => (
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor={`contract-${name}`}>
                      {t(`dashboard:pool.contract.fields.${name}`)}
                    </Label>
                    <Input
                      id={`contract-${name}`}
                      className="h-11 font-mono"
                      autoComplete="off"
                      spellCheck={false}
                      inputMode={name === "dimensions" ? "numeric" : undefined}
                      placeholder={placeholder}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldErrors field={field} />
                  </div>
                )}
              </form.Field>
            ))}
            <form.Field name="normalization">
              {(field) => (
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="contract-normalization">
                    {t("dashboard:pool.contract.fields.normalization")}
                  </Label>
                  <NativeSelect
                    id="contract-normalization"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value as (typeof NORMALIZATIONS)[number])
                    }
                  >
                    {NORMALIZATIONS.map((value) => (
                      <option key={value} value={value}>
                        {t(`dashboard:pool.contract.normalizations.${value}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </form.Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(submitting) => (
                <Button type="submit" size="touch" disabled={submitting || update.isPending}>
                  {submitting ? t("common:actions.saving") : t("common:actions.save")}
                </Button>
              )}
            </form.Subscribe>
            {current ? (
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={update.isPending}
                onClick={async () => {
                  const ok = await save(() =>
                    update.mutateAsync({ poolId: pool.id, cloud: { embeddingContract: null } }),
                  );
                  if (ok)
                    form.reset({
                      model: "",
                      revision: "",
                      dimensions: "",
                      normalization: "none",
                      vectorSpace: "",
                    });
                }}
              >
                {t("dashboard:pool.contract.clear")}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The owner's consent that share holders may pay with their own provider key (human-only). */
function OwnKeyCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const save = usePoolSaved();
  const setEquivalent = useMutation({
    ...orpc.pools.cloud.setOwnKeyEquivalent.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const current = pool.cloud.ownKeyEquivalentModel;
  const form = useForm({
    defaultValues: { model: current ?? "" },
    validators: {
      onSubmit: z.object({
        model: z
          .string()
          .trim()
          .min(1, t("dashboard:pool.ownKey.required"))
          .max(256, t("dashboard:pool.ownKey.tooLong")),
      }),
    },
    onSubmit: async ({ value }) => {
      await save(() => setEquivalent.mutateAsync({ poolId: pool.id, model: value.model.trim() }));
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.ownKey.title")}</CardTitle>
        <CardDescription>{t("dashboard:pool.ownKey.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <p className="text-sm">
          {current ? (
            <>
              {t("dashboard:pool.ownKey.current")}{" "}
              <code className="break-all font-mono">{current}</code>
            </>
          ) : (
            <span className="text-muted-foreground">{t("dashboard:pool.ownKey.none")}</span>
          )}
        </p>
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="model">
            {(field) => (
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="own-key-model">{t("dashboard:pool.ownKey.model")}</Label>
                <Input
                  id="own-key-model"
                  className="h-11 font-mono"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="openai/gpt-4o-mini"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button
                type="submit"
                size="touch"
                className="sm:mt-6"
                disabled={submitting || setEquivalent.isPending}
              >
                {t("dashboard:pool.ownKey.save")}
              </Button>
            )}
          </form.Subscribe>
          {current ? (
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="sm:mt-6"
              disabled={setEquivalent.isPending}
              onClick={async () => {
                const ok = await save(() =>
                  setEquivalent.mutateAsync({ poolId: pool.id, model: null }),
                );
                if (ok) form.reset({ model: "" });
              }}
            >
              {t("dashboard:pool.ownKey.withdraw")}
            </Button>
          ) : null}
        </form>
        <p className="text-xs text-muted-foreground">{t("dashboard:pool.ownKey.clears")}</p>
        <p className="text-xs text-muted-foreground">{t("dashboard:pool.cloud.humanOnly")}</p>
      </CardContent>
    </Card>
  );
}

const HISTORY_PAGE = 20;

/** The locale key of a history entry; a slug change is called out among pool updates. */
function historyActionKey(item: { action: string; after: unknown }): string {
  const changesSlug =
    item.action === "pool.update" &&
    typeof item.after === "object" &&
    item.after !== null &&
    "slug" in item.after;
  return changesSlug ? "pool_update_slug" : item.action.replaceAll(".", "_");
}

function HistoryCard({ poolId }: { poolId: string }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const history = useInfiniteQuery(
    orpc.pools.history.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        poolId,
        limit: HISTORY_PAGE,
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.history.title")}</CardTitle>
        <CardDescription>{t("dashboard:pool.history.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {history.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : history.isError ? (
          <InlineRetry
            message={t("dashboard:pool.history.loadFailed")}
            onRetry={() => history.refetch()}
          />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:pool.history.empty")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {items.map((item) => (
              <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 break-words">
                  {t(`dashboard:pool.history.actions.${historyActionKey(item)}`, {
                    defaultValue: item.action,
                  })}
                </span>
                <StatusPill tone={item.actor.actor === "AGENT" ? "info" : "muted"}>
                  {item.actor.label ?? t(`dashboard:pool.history.actor.${item.actor.actor}`)}
                </StatusPill>
                <span className="text-xs text-muted-foreground">
                  <TimeAgo value={item.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {history.hasNextPage ? (
          <Button
            variant="outline"
            size="touch"
            className="self-start"
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
          >
            {t("dashboard:pool.history.more")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
