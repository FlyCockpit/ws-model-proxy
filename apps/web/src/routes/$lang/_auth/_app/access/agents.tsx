import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AgentScope } from "@ws-model-proxy/api/contracts";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { Bot, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAccessSummary } from "@/components/access/agent-access-choice";
import { ConfirmAction } from "@/components/access/confirm-action";
import { CreateAgentTokenDialog } from "@/components/access/create-agent-token-dialog";
import { CredentialDatesList, CredentialStatusBadge } from "@/components/access/credential-meta";
import { credentialStatus } from "@/components/access/credential-meta-utils";
import { EditAgentAccessDialog } from "@/components/access/edit-agent-access-dialog";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/access/agents")({
  staticData: { pendingShape: "list" },
  component: AccessAgentsPage,
});

type AgentTokenView = {
  id: string;
  name: string;
  scopes: AgentScope[];
  nodeIds: string[] | null;
  lookupPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

function AccessAgentsPage() {
  const { t } = useTranslation(["access"]);
  const tokens = useQuery(orpc.access.agentTokens.list.queryOptions());
  const flags = useQuery(orpc.app.flags.queryOptions());
  const mcpOff = flags.data?.mcpEnabled === false;
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="accessAgents" />
      {tokens.isPending ? (
        // The card itself with only the URL as a skeleton, so the page does not move when it loads.
        <Card aria-hidden="true">
          <CardContent className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium">{t("access:agents.mcpUrl")}</p>
            <Skeleton className="h-11 w-full" />
            <p className="text-xs text-muted-foreground">{t("access:agents.mcpHint")}</p>
          </CardContent>
        </Card>
      ) : tokens.isError ? null : (
        <Card>
          <CardContent className="min-w-0 flex-1 space-y-1.5">
            <p className="text-sm font-medium">{t("access:agents.mcpUrl")}</p>
            <CodeSnippet code={tokens.data.mcpUrl} copyLabel={t("access:agents.copyMcpUrl")} />
            <p className="text-xs text-muted-foreground">{t("access:agents.mcpHint")}</p>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle>{t("access:agents.tokensTitle")}</CardTitle>
            <CardDescription>{t("access:agents.tokensDescription")}</CardDescription>
          </div>
          <Button type="button" size="touch" disabled={mcpOff} onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" />
            {t("access:agents.create")}
          </Button>
          {mcpOff ? (
            <p className="w-full text-sm text-muted-foreground">{t("access:agents.mcpOff")}</p>
          ) : null}
        </CardHeader>
        <CardContent className="min-w-0">
          {tokens.isPending ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : tokens.isError ? (
            <InlineRetry message={t("access:agents.loadFailed")} onRetry={() => tokens.refetch()} />
          ) : tokens.data.tokens.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Bot aria-hidden="true" className="size-4" />
              {t("access:agents.empty")}
            </p>
          ) : (
            <TokenList tokens={tokens.data.tokens} />
          )}
        </CardContent>
      </Card>
      {/* Below the tokens only once they have loaded: their skeleton and the list differ in
          height, and a card drawn under them would jump. */}
      {tokens.isPending ? null : <OAuthConnections />}
      <CreateAgentTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        mcpUrl={tokens.data?.mcpUrl ?? null}
      />
    </div>
  );
}

function TokenList({ tokens }: { tokens: AgentTokenView[] }) {
  const now = Date.now();
  return (
    <ul className="flex min-w-0 flex-col divide-y">
      {tokens.map((token) => (
        <li key={token.id} className="py-3 first:pt-0 last:pb-0">
          <TokenRow token={token} now={now} />
        </li>
      ))}
    </ul>
  );
}

function TokenRow({ token, now }: { token: AgentTokenView; now: number }) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const revoke = useMutation(
    orpc.access.agentTokens.revoke.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:revoke.done"));
        await queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() });
      },
    }),
  );
  const setAccess = useMutation(
    orpc.access.agentTokens.setAccess.mutationOptions({
      onSuccess: () => {
        toast.success(t("access:agents.accessChanged"));
      },
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: orpc.access.agentTokens.list.key() }),
    }),
  );
  const status = credentialStatus(token, now);
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{token.name}</span>
          <CredentialStatusBadge status={status} />
        </div>
        <AgentAccessSummary scopes={token.scopes} nodeIds={token.nodeIds} />
        <p className="break-all font-mono text-xs text-muted-foreground">{token.lookupPrefix}…</p>
        <CredentialDatesList row={token} />
        {status === "blocked" ? (
          <p data-policy-notice="" className="text-xs text-destructive">
            {t("access:agents.blockedByPolicy")}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap gap-2 self-start">
        {status === "active" ? (
          <Button type="button" variant="outline" size="touch" onClick={() => setEditOpen(true)}>
            {t("access:agents.edit")}
          </Button>
        ) : null}
        {status !== "revoked" ? (
          <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
            {t("access:revoke.action")}
          </Button>
        ) : null}
      </div>
      {editOpen ? (
        <EditAgentAccessDialog
          name={token.name}
          access={{ scopes: token.scopes, nodeIds: token.nodeIds }}
          onClose={() => setEditOpen(false)}
          onSave={(access) => setAccess.mutateAsync({ agentTokenId: token.id, ...access })}
        />
      ) : null}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:agents.revokeTitle", { name: token.name })}
        description={t("access:agents.revokeDescription")}
        confirmLabel={t("access:revoke.action")}
        pendingLabel={t("access:revoke.pending")}
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate({ agentTokenId: token.id })}
      />
    </div>
  );
}

function OAuthConnections() {
  const { t } = useTranslation(["access"]);
  const grants = useQuery(orpc.access.oauthGrants.list.queryOptions());
  const active = grants.data?.connections.filter((connection) => !connection.revokedAt) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("access:agents.oauthTitle")}</CardTitle>
        <CardDescription>{t("access:agents.oauthDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        {grants.isPending ? (
          <Skeleton aria-hidden="true" className="h-16 w-full" />
        ) : grants.isError ? (
          <InlineRetry
            message={t("access:agents.oauthLoadFailed")}
            onRetry={() => grants.refetch()}
          />
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access:agents.oauthEmpty")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {active.map((connection) => (
              <li key={connection.grantId} className="py-3 first:pt-0 last:pb-0">
                <OAuthRow connection={connection} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function OAuthRow({
  connection,
}: {
  connection: {
    grantId: string;
    clientName: string | null;
    redirectHost: string | null;
    scopes: AgentScope[];
    nodeIds: string[] | null;
    availableScopes: AgentScope[];
    createdAt: string;
  };
}) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const name = connection.clientName ?? t("access:agents.unnamedClient");
  const revoke = useMutation(
    orpc.access.oauthGrants.revoke.mutationOptions({
      onSuccess: async () => {
        setConfirmOpen(false);
        toast.success(t("access:agents.disconnected"));
        await queryClient.invalidateQueries({ queryKey: orpc.access.oauthGrants.list.key() });
      },
    }),
  );
  const setAccess = useMutation(
    orpc.access.oauthGrants.setAccess.mutationOptions({
      onSuccess: () => {
        toast.success(t("access:agents.accessChanged"));
      },
      onSettled: () =>
        queryClient.invalidateQueries({ queryKey: orpc.access.oauthGrants.list.key() }),
    }),
  );
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium">{name}</span>
        </div>
        <p className="text-xs text-muted-foreground">
          {connection.redirectHost ? `${connection.redirectHost} · ` : null}
          <TimeAgo value={connection.createdAt} />
        </p>
        <AgentAccessSummary scopes={connection.scopes} nodeIds={connection.nodeIds} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 self-start sm:self-center">
        <Button type="button" variant="outline" size="touch" onClick={() => setEditOpen(true)}>
          {t("access:agents.edit")}
        </Button>
        <Button type="button" variant="outline" size="touch" onClick={() => setConfirmOpen(true)}>
          {t("access:agents.disconnect")}
        </Button>
      </div>
      {editOpen ? (
        <EditAgentAccessDialog
          name={name}
          access={{ scopes: connection.scopes, nodeIds: connection.nodeIds }}
          availableScopes={connection.availableScopes}
          onClose={() => setEditOpen(false)}
          onSave={(access) => setAccess.mutateAsync({ grantId: connection.grantId, ...access })}
        />
      ) : null}
      <ConfirmAction
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("access:agents.disconnectTitle", { name })}
        description={t("access:agents.disconnectDescription")}
        confirmLabel={t("access:agents.disconnect")}
        isPending={revoke.isPending}
        onConfirm={() => revoke.mutate({ grantId: connection.grantId })}
      />
    </div>
  );
}
