import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CreateAgentTokenDialog } from "@/components/access/create-agent-token-dialog";
import { CodeSnippet } from "@/components/code-snippet";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

/**
 * Welcome step 4: the MCP URL, how OAuth connects an agent, an agent token (Read-only or Full,
 * the Access → Agents dialog) for agents without OAuth, and a first prompt to try.
 */
export function AgentStep() {
  const { t } = useTranslation(["dashboard", "access"]);
  const queryClient = useQueryClient();
  const tokens = useQuery(orpc.access.agentTokens.list.queryOptions());
  const flags = useQuery(orpc.app.flags.queryOptions());
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const mcpOff = flags.data?.mcpEnabled === false;
  const node = nodes.data?.nodes[0];
  const prompt = node
    ? t("dashboard:welcome.agent.promptNode", { node: node.slug })
    : t("dashboard:welcome.agent.promptNoNode");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {tokens.isPending ? (
        <Skeleton aria-hidden="true" className="h-16 w-full rounded-lg" />
      ) : tokens.isError ? (
        <InlineRetry message={t("access:agents.loadFailed")} onRetry={() => tokens.refetch()} />
      ) : (
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-medium">{t("access:agents.mcpUrl")}</p>
          <CodeSnippet code={tokens.data.mcpUrl} copyLabel={t("access:agents.copyMcpUrl")} />
        </div>
      )}
      {mcpOff ? <p className="text-sm text-muted-foreground">{t("access:agents.mcpOff")}</p> : null}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <section className="min-w-0 space-y-1.5 rounded-lg border p-4">
          <h3 className="font-medium">{t("dashboard:welcome.agent.oauthTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("dashboard:welcome.agent.oauthHint")}</p>
        </section>
        <section className="flex min-w-0 flex-col items-start gap-2 rounded-lg border p-4">
          <h3 className="font-medium">{t("dashboard:welcome.agent.tokenTitle")}</h3>
          <p className="text-sm text-muted-foreground">{t("dashboard:welcome.agent.tokenHint")}</p>
          <Button
            type="button"
            size="touch"
            className="mt-auto"
            disabled={mcpOff}
            onClick={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" />
            {t("access:agents.create")}
          </Button>
        </section>
      </div>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium">{t("dashboard:welcome.agent.promptTitle")}</p>
        <CodeSnippet code={prompt} copyLabel={t("dashboard:welcome.agent.copyPrompt")} />
      </div>
      <CreateAgentTokenDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) void queryClient.invalidateQueries({ queryKey: orpc.activity.overview.key() });
        }}
        mcpUrl={tokens.data?.mcpUrl ?? null}
      />
    </div>
  );
}
