import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EndpointCard } from "@/components/access/api-endpoint-card";
import { ConfirmAction } from "@/components/access/confirm-action";
import { CreateApiKeyDialog } from "@/components/access/create-api-key-dialog";
import {
  CredentialDatesList,
  CredentialStatusBadge,
  credentialStatus,
} from "@/components/access/credential-meta";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
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

/** What a key can call: all pools, or one chip per selected pool, named by its callable id. */
function CanUseChips({ apiKey }: { apiKey: ApiKeyView }) {
  const { t } = useTranslation(["access"]);
  const pools = useQuery({
    ...orpc.pools.list.queryOptions(),
    enabled: apiKey.scope === "SELECTED_POOLS",
  });
  const names = new Map<string, string>();
  for (const pool of pools.data?.pools ?? []) names.set(pool.id, pool.callableIds[0] ?? pool.slug);
  for (const pool of pools.data?.sharedWithMe ?? [])
    names.set(pool.poolId, pool.callableIds[0] ?? pool.poolId);
  const chips =
    apiKey.scope === "ALL_POOLS"
      ? [{ key: "all", label: t("access:apiKeys.allPools"), known: true }]
      : apiKey.poolIds.map((poolId) => {
          const name = names.get(poolId);
          return { key: poolId, label: name ?? t("access:apiKeys.poolGone"), known: !!name };
        });
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs text-muted-foreground">{t("access:apiKeys.canUse")}</p>
      {apiKey.scope === "SELECTED_POOLS" && pools.isPending ? (
        <Skeleton className="h-6 w-40" />
      ) : apiKey.scope === "SELECTED_POOLS" && pools.isError ? (
        <p className="text-xs">{t("access:apiKeys.poolCount", { count: apiKey.poolIds.length })}</p>
      ) : (
        <ul className="flex min-w-0 flex-wrap gap-1.5">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className={cn(
                "inline-flex min-w-0 max-w-full items-center rounded-full border px-2 py-0.5 text-xs",
                chip.known ? "font-mono" : "text-muted-foreground italic",
              )}
            >
              <span className="truncate">{chip.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
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
          <CanUseChips apiKey={apiKey} />
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
