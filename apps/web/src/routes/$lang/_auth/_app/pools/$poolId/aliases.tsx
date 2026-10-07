import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { MODEL_ALIAS_NAME, modelAliasNameProblem } from "@ws-model-proxy/api/lib/request-compat";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
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
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CodeSnippet } from "@/components/code-snippet";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { refusalMessage } from "@/components/nodes/refusal";
import { StatusPill } from "@/components/status-pill";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/aliases")({
  component: PoolAliasesPage,
});

type AliasView = Awaited<
  ReturnType<AppRouterClient["pools"]["aliases"]["list"]>
>["aliases"][number];
type ApiKeyView = Awaited<ReturnType<AppRouterClient["access"]["apiKeys"]["list"]>>["keys"][number];

const K = "dashboard:pool.aliases";
/**
 * Mirrors `modelAliasNameSchema` (packages/api/src/contracts/pools.ts), which the web cannot
 * import on its own; the server validates again.
 */

/** Keys that may call this pool now (the server refuses others with alias_key_not_allowed). */
function keysForPool(keys: readonly ApiKeyView[], poolId: string, now: number): ApiKeyView[] {
  return keys.filter(
    (key) =>
      key.revokedAt === null &&
      (key.expiresAt === null || new Date(key.expiresAt).getTime() > now) &&
      (key.scope === "ALL_POOLS" || key.poolIds.includes(poolId)),
  );
}

function PoolAliasesPage() {
  const { t } = useTranslation(["dashboard"]);
  const { poolId } = Route.useParams();
  const aliases = useQuery(orpc.pools.aliases.list.queryOptions());
  const keys = useQuery(orpc.access.apiKeys.list.queryOptions());
  if (aliases.isPending || keys.isPending)
    return (
      <div className="flex min-w-0 flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  if (aliases.isError || keys.isError)
    return (
      <InlineRetry
        message={t(`${K}.loadFailed`)}
        onRetry={() => {
          aliases.refetch();
          keys.refetch();
        }}
      />
    );
  const mine = aliases.data.aliases.filter((alias) => alias.poolId === poolId);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(`${K}.title`)}</CardTitle>
          <CardDescription>{t(`${K}.intro`)}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">{t(`${K}.private`)}</p>
          <p className="text-sm text-muted-foreground">{t(`${K}.modelsHint`)}</p>
          <CodeSnippet
            code={`curl ${keys.data.baseUrl}/models -H "Authorization: Bearer $WSMP_API_KEY"`}
            copyLabel={t(`${K}.copyModels`)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(`${K}.listTitle`)}</CardTitle>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {mine.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(`${K}.empty`)}</p>
          ) : (
            <ul className="flex min-w-0 flex-col divide-y">
              {mine.map((alias) => (
                <AliasRow key={alias.id} alias={alias} />
              ))}
            </ul>
          )}
          <AddAliasForm poolId={poolId} keys={keysForPool(keys.data.keys, poolId, Date.now())} />
        </CardContent>
      </Card>
    </div>
  );
}

function AliasRow({ alias }: { alias: AliasView }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const remove = useMutation({
    ...orpc.pools.aliases.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <li className="flex min-w-0 items-center gap-2 py-2">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 break-all font-mono text-sm">{alias.name}</code>
          {alias.usable ? null : <StatusPill tone="busy">{t(`${K}.unusable`)}</StatusPill>}
        </div>
        <p className="break-all text-xs text-muted-foreground">
          {alias.apiKeyId === null
            ? t(`${K}.allKeys`)
            : alias.apiKeyName === null
              ? t(`${K}.oneKey`)
              : t(`${K}.onlyKey`, { name: alias.apiKeyName })}
        </p>
        {alias.usable ? null : (
          <p className="text-xs text-muted-foreground">{t(`${K}.unusableHint`)}</p>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-touch"
        disabled={remove.isPending}
        aria-label={t(`${K}.remove`, { name: alias.name })}
        onClick={async () => {
          try {
            await remove.mutateAsync({ aliasId: alias.id });
            await queryClient.invalidateQueries({ queryKey: orpc.pools.aliases.key() });
            toast.success(t(`${K}.removed`, { name: alias.name }));
          } catch (error) {
            toast.error(refusalMessage(t, error));
          }
        }}
      >
        <Trash2 aria-hidden="true" />
      </Button>
    </li>
  );
}

function AddAliasForm({ poolId, keys }: { poolId: string; keys: ApiKeyView[] }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const set = useMutation({
    ...orpc.pools.aliases.set.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { name: "", apiKeyId: "" },
    validators: {
      onSubmit: z.object({
        name: z
          .string()
          .trim()
          .min(1, t(`${K}.errors.nameRequired`))
          .regex(MODEL_ALIAS_NAME, t(`${K}.errors.nameInvalid`))
          .refine(
            (name) => modelAliasNameProblem(name) !== "external",
            t(`${K}.errors.nameExternal`),
          )
          .refine(
            (name) => modelAliasNameProblem(name) !== "runtime",
            t(`${K}.errors.nameRuntime`),
          ),
        apiKeyId: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const name = value.name.trim();
      try {
        await set.mutateAsync({ name, poolId, apiKeyId: value.apiKeyId || null });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.aliases.key() });
        toast.success(t(`${K}.added`, { name }));
        form.reset();
      } catch (error) {
        toast.error(refusalMessage(t, error));
      }
    },
  });
  return (
    <form
      className="flex min-w-0 flex-col gap-3 rounded-md border border-dashed p-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <p className="text-sm font-medium">{t(`${K}.add`)}</p>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <form.Field name="name">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="alias-name">{t(`${K}.name`)}</Label>
              <Input
                id="alias-name"
                className="h-11 font-mono"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder="gpt-4o"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="apiKeyId">
          {(field) => (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="alias-key">{t(`${K}.key`)}</Label>
              <NativeSelect
                id="alias-key"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              >
                <option value="">{t(`${K}.allKeys`)}</option>
                {keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </form.Field>
      </div>
      <p className="text-xs text-muted-foreground">{t(`${K}.moveHint`)}</p>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(submitting) => (
          <Button type="submit" size="touch" className="self-start" disabled={submitting}>
            <Plus aria-hidden="true" />
            {submitting ? t("common:actions.saving") : t(`${K}.addButton`)}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
