import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@ws-model-proxy/ui/components/alert-dialog";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

/**
 * Human MCP grant management panel (Phase 7): one card per
 * authorized client, with a ceremonial AlertDialog revoke. Human-only by
 * construction — the backing procedures take no caller-supplied user id and
 * are excluded from the MCP tool catalog. The panel deliberately does NOT
 * render remote client icons (the projection never requests them either).
 */
export function McpGrantsPanel() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [pendingRevokeRecordId, setPendingRevokeRecordId] = useState<string | null>(null);

  const {
    data: connections,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.mcpGrants.listMine.queryOptions());

  const revoke = useMutation(
    orpc.mcpGrants.revokeMine.mutationOptions({
      onSuccess: () => {
        // Invalidate ONLY the grant-list query: revocation changes nothing
        // else any other query reads.
        queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.listMine.queryKey() });
        toast.success(t("settings:mcp.revoked"));
        setPendingRevokeRecordId(null);
      },
      onError: () => {
        toast.error(t("settings:mcp.revokeFailed"));
      },
    }),
  );

  const pendingConnection = connections?.find(
    (connection) => connection.clientRecordId === pendingRevokeRecordId,
  );

  if (isPending) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("settings:mcp.title")}</CardTitle>
            <CardDescription>{t("settings:mcp.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-9 w-32" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError) {
    return <InlineRetry message={t("settings:mcp.loadFailed")} onRetry={() => refetch()} />;
  }

  return (
    <div className="space-y-6">
      {connections.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("settings:mcp.title")}</CardTitle>
            <CardDescription>{t("settings:mcp.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{t("settings:mcp.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        connections.map((connection) => (
          <Card key={connection.clientRecordId}>
            <CardHeader>
              <CardTitle className="min-w-0 break-words">
                {connection.name ?? connection.clientId}
              </CardTitle>
              <CardDescription className="min-w-0 max-w-full break-words">
                <code className="font-mono text-xs">{connection.clientId}</code>
                {connection.uri ? (
                  <span className="mt-1 block truncate">{connection.uri}</span>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("settings:mcp.scopes")}
                </p>
                {connection.scopes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("settings:mcp.noScopes")}</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {connection.scopes.map((scope) => (
                      <li
                        key={scope}
                        className="min-w-0 break-all rounded bg-muted px-2 py-0.5 font-mono text-xs"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t("settings:mcp.firstAuthorized")}
                  </dt>
                  <dd className="text-sm">{connection.firstAuthorizedAt.toLocaleDateString()}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t("settings:mcp.lastAuthorized")}
                  </dt>
                  <dd className="text-sm">{connection.lastAuthorizedAt.toLocaleDateString()}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t("settings:mcp.rollingExpiry")}
                  </dt>
                  <dd className="text-sm">
                    {connection.rollingExpiryAt
                      ? connection.rollingExpiryAt.toLocaleString()
                      : t("settings:mcp.noActiveRefresh")}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-muted-foreground">
                    {t("settings:mcp.activeRefreshCount", {
                      count: connection.activeRefreshCount,
                    })}
                  </dt>
                  <dd className="text-sm">{t(`settings:mcp.dpop.${connection.dpop}`)}</dd>
                </div>
              </dl>
              <Button
                type="button"
                variant="destructive"
                className="min-h-[44px]"
                disabled={revoke.isPending}
                onClick={() => setPendingRevokeRecordId(connection.clientRecordId)}
              >
                {t("settings:mcp.revoke")}
              </Button>
            </CardContent>
          </Card>
        ))
      )}

      <AlertDialog
        open={pendingRevokeRecordId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevokeRecordId(null);
        }}
      >
        <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]! data-[size=sm]:sm:max-w-md!">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:mcp.revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="min-w-0 max-w-full break-words">
              {pendingConnection
                ? t("settings:mcp.revokeDescription", {
                    client: pendingConnection.name ?? pendingConnection.clientId,
                  })
                : t("settings:mcp.revokeDescription", { client: "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel
              className="min-h-[44px] w-full sm:w-auto"
              disabled={revoke.isPending}
            >
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              className="min-h-[44px] w-full sm:w-auto"
              disabled={revoke.isPending || pendingRevokeRecordId === null}
              onClick={() => {
                if (pendingRevokeRecordId === null) return;
                revoke.mutate({
                  clientRecordId: pendingRevokeRecordId,
                  confirm: "REVOKE",
                });
              }}
            >
              {revoke.isPending ? t("settings:mcp.revoking") : t("settings:mcp.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
