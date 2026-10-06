import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { ConfirmAction } from "@/components/access/confirm-action";
import {
  CredentialDatesList,
  CredentialStatusBadge,
  credentialStatus,
  EXPIRY_CHOICES,
  type ExpiryChoice,
  expiryFromChoice,
} from "@/components/access/credential-meta";
import { SecretReveal } from "@/components/access/secret-reveal";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/api-keys")({
  component: AccessApiKeysPage,
});

type ApiKeyView = {
  id: string;
  name: string;
  scope: "ALL_POOLS" | "SELECTED_POOLS";
  poolIds: string[];
  lookupPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

function AccessApiKeysPage() {
  const { t } = useTranslation(["access", "dashboard"]);
  const keys = useQuery(orpc.access.apiKeys.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <PageHeading page="accessApiKeys" />
        <Button type="button" size="touch" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          {t("access:apiKeys.create")}
        </Button>
      </div>
      {keys.isPending ? (
        <ApiKeysSkeleton />
      ) : keys.isError ? (
        <InlineRetry message={t("access:apiKeys.loadFailed")} onRetry={() => keys.refetch()} />
      ) : (
        <>
          <EndpointCard baseUrl={keys.data.baseUrl} />
          <ApiKeyList keys={keys.data.keys} />
        </>
      )}
      <CreateApiKeyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ApiKeysSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-20 w-full rounded-xl" />
    </div>
  );
}

function EndpointCard({ baseUrl }: { baseUrl: string }) {
  const { t } = useTranslation(["access"]);
  const example = `curl ${baseUrl}/chat/completions \\\n  -H "Authorization: Bearer $WSMP_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "<owner>/<pool>", "messages": [{"role": "user", "content": "Hello"}]}'`;
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("access:apiKeys.endpoint")}</p>
          <CodeSnippet code={baseUrl} copyLabel={t("access:apiKeys.copyEndpoint")} />
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("access:apiKeys.example")}</p>
          <CodeSnippet code={example} copyLabel={t("access:apiKeys.copyExample")} />
        </div>
      </CardContent>
    </Card>
  );
}

function ApiKeyList({ keys }: { keys: ApiKeyView[] }) {
  const { t } = useTranslation(["access"]);
  if (keys.length === 0) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 text-sm text-muted-foreground">
          <KeyRound aria-hidden="true" className="size-4" />
          {t("access:apiKeys.empty")}
        </CardContent>
      </Card>
    );
  }
  const now = Date.now();
  return (
    <ul className="flex min-w-0 flex-col gap-3">
      {keys.map((key) => (
        <li key={key.id}>
          <ApiKeyRow apiKey={key} now={now} />
        </li>
      ))}
    </ul>
  );
}

function ApiKeyRow({ apiKey, now }: { apiKey: ApiKeyView; now: number }) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const revoke = useMutation(
    orpc.access.apiKeys.revoke.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:revoke.done"));
        await queryClient.invalidateQueries({ queryKey: orpc.access.apiKeys.list.key() });
      },
    }),
  );
  const status = credentialStatus(apiKey, now);
  return (
    <Card>
      <CardContent className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium">{apiKey.name}</span>
            <CredentialStatusBadge status={status} />
          </div>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {apiKey.lookupPrefix}…
          </p>
          <p className="text-xs text-muted-foreground">
            {apiKey.scope === "ALL_POOLS"
              ? t("access:apiKeys.allPools")
              : t("access:apiKeys.poolCount", { count: apiKey.poolIds.length })}
          </p>
          <CredentialDatesList row={apiKey} />
        </div>
        {status !== "revoked" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            className="self-start"
            onClick={() => setConfirmOpen(true)}
          >
            {t("access:revoke.action")}
          </Button>
        ) : null}
      </CardContent>
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:apiKeys.revokeTitle", { name: apiKey.name })}
        description={t("access:apiKeys.revokeDescription")}
        confirmLabel={t("access:revoke.action")}
        pendingLabel={t("access:revoke.pending")}
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate({ apiKeyId: apiKey.id })}
      />
    </Card>
  );
}

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    scope: z.enum(["ALL_POOLS", "SELECTED_POOLS"]),
    poolIds: z.array(z.string()),
    expiry: z.enum(EXPIRY_CHOICES),
  })
  .refine((value) => value.scope === "ALL_POOLS" || value.poolIds.length > 0, {
    path: ["poolIds"],
  });

function CreateApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["access"]);
  const [secret, setSecret] = useState<string | null>(null);
  // Owned here so the dialog cannot close while the key is being minted (a late result would
  // otherwise reveal the secret later); `gcTime: 0` keeps it out of the mutation cache.
  const create = useMutation({ ...orpc.access.apiKeys.create.mutationOptions(), gcTime: 0 });
  const close = () => {
    if (create.isPending) return;
    setSecret(null);
    create.reset();
    onOpenChange(false);
  };
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title={secret ? t("access:apiKeys.created") : t("access:apiKeys.createTitle")}
      description={secret ? undefined : t("access:apiKeys.createDescription")}
    >
      {secret ? (
        <SecretReveal value={secret} onDone={close} />
      ) : open ? (
        <CreateApiKeyForm
          create={create.mutateAsync}
          onCreated={(value) => {
            setSecret(value);
            create.reset();
          }}
        />
      ) : null}
    </ResponsiveDialog>
  );
}

type CreateApiKey = (input: {
  name: string;
  scope: "ALL_POOLS" | "SELECTED_POOLS";
  poolIds: string[];
  expiresAt: string | null;
}) => Promise<{ secret: string }>;

function CreateApiKeyForm({
  create,
  onCreated,
}: {
  create: CreateApiKey;
  onCreated: (secret: string) => void;
}) {
  const { t } = useTranslation(["access", "common"]);
  const queryClient = useQueryClient();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const form = useForm({
    defaultValues: {
      name: "",
      scope: "ALL_POOLS" as "ALL_POOLS" | "SELECTED_POOLS",
      poolIds: [] as string[],
      expiry: "never" as ExpiryChoice,
    },
    validators: { onSubmit: createSchema },
    onSubmit: async ({ value }) => {
      // A failure is toasted by the global mutation error handler.
      const result = await create({
        name: value.name.trim(),
        scope: value.scope,
        poolIds: value.scope === "SELECTED_POOLS" ? value.poolIds : [],
        expiresAt: expiryFromChoice(value.expiry, Date.now()),
      }).catch(() => null);
      if (!result) return;
      await queryClient.invalidateQueries({ queryKey: orpc.access.apiKeys.list.key() });
      onCreated(result.secret);
    },
  });
  const usablePools = pools.data
    ? [
        ...pools.data.pools.map((pool) => ({
          id: pool.id,
          label: pool.callableIds[0] ?? pool.slug,
        })),
        ...pools.data.sharedWithMe
          .filter((pool) => pool.canUse)
          .map((pool) => ({ id: pool.poolId, label: pool.callableIds[0] ?? pool.poolId })),
      ]
    : [];

  return (
    <form
      className="flex min-w-0 flex-col gap-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{t("access:fields.name")}</Label>
            <Input
              id={field.name}
              autoComplete="off"
              className="min-h-11"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={
                field.state.meta.errors.length > 0 ? "api-key-name-error" : undefined
              }
            />
            {field.state.meta.errors.length > 0 ? (
              <p id="api-key-name-error" className="text-sm text-destructive">
                {t("access:fields.nameRequired")}
              </p>
            ) : null}
          </div>
        )}
      </form.Field>
      <form.Field name="scope">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("access:apiKeys.scope")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("access:apiKeys.scope")}
              items={[
                { value: "ALL_POOLS", label: t("access:apiKeys.scopeAll") },
                { value: "SELECTED_POOLS", label: t("access:apiKeys.scopeSelected") },
              ]}
            />
            {field.state.value === "ALL_POOLS" ? (
              <p className="text-xs text-muted-foreground">{t("access:apiKeys.scopeAllHint")}</p>
            ) : null}
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.scope}>
        {(scope) =>
          scope === "SELECTED_POOLS" ? (
            <form.Field name="poolIds">
              {(field) => (
                <fieldset className="min-w-0 space-y-1">
                  <legend className="sr-only">{t("access:apiKeys.scopeSelected")}</legend>
                  {pools.isPending ? (
                    <Skeleton className="h-11 w-full" />
                  ) : pools.isError ? (
                    <p className="text-sm text-muted-foreground">
                      {t("access:apiKeys.poolsUnavailable")}
                    </p>
                  ) : usablePools.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("access:apiKeys.noPools")}</p>
                  ) : (
                    usablePools.map((pool) => {
                      const checked = field.state.value.includes(pool.id);
                      const id = `api-key-pool-${pool.id}`;
                      return (
                        <label
                          key={pool.id}
                          htmlFor={id}
                          className="flex min-h-11 min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted"
                        >
                          <Checkbox
                            id={id}
                            checked={checked}
                            onCheckedChange={(next) =>
                              field.handleChange(
                                next === true
                                  ? [...field.state.value, pool.id]
                                  : field.state.value.filter((poolId) => poolId !== pool.id),
                              )
                            }
                          />
                          <span className="truncate font-mono text-sm">{pool.label}</span>
                        </label>
                      );
                    })
                  )}
                  {field.state.meta.errors.length > 0 ? (
                    <p className="text-sm text-destructive">{t("access:apiKeys.pickPools")}</p>
                  ) : null}
                </fieldset>
              )}
            </form.Field>
          ) : null
        }
      </form.Subscribe>
      <form.Field name="expiry">
        {(field) => (
          <div className="min-w-0 space-y-2">
            <Label>{t("access:fields.expiry")}</Label>
            <SegmentedControl
              value={field.state.value}
              onChange={field.handleChange}
              ariaLabel={t("access:fields.expiry")}
              items={EXPIRY_CHOICES.map((choice) => ({
                value: choice,
                label: t(`access:expiry.${choice}`),
              }))}
            />
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" disabled={isSubmitting}>
            {isSubmitting ? t("access:apiKeys.creating") : t("access:apiKeys.create")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
