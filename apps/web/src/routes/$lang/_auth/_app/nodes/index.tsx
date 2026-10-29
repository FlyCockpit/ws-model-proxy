import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Plus, Server } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { LiveUpdatesNotice } from "@/components/live-updates-notice";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { AgentUpdateAllCard } from "@/components/nodes/agent-update-all-card";
import { EnrollmentCodesCard } from "@/components/nodes/enrollment-codes-card";
import { FabricsCard } from "@/components/nodes/fabrics-card";
import { NodeCard, NodeCardSkeleton } from "@/components/nodes/node-card";
import { PageHeading } from "@/components/page-stub";
import { useAgentUpdateOverview } from "@/hooks/use-agent-update-overview";
import { nodeLiveInterval } from "@/lib/node-live-updates";
import { useNodeLive } from "@/stores/node-live";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/nodes/")({
  component: NodesPage,
});

/**
 * Node list refresh without live updates (a node that enrolls shows up without a reload); with
 * them, slowly for the heartbeat's free memory and last seen.
 */
const NODES_REFRESH_MS = 10_000;
const NODES_LIVE_REFRESH_MS = 60_000;

function NodesPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const [adding, setAdding] = useState(false);
  const liveStatus = useNodeLive((state) => state.status);
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions(),
    refetchInterval: nodeLiveInterval(liveStatus, NODES_REFRESH_MS, NODES_LIVE_REFRESH_MS),
  });
  const agentUpdates = useAgentUpdateOverview();
  const updateOf = (nodeId: string) =>
    agentUpdates.data?.nodes.find((view) => view.nodeId === nodeId);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="nodes" />
        <Button className="min-h-[44px]" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {t("dashboard:nodes.list.addNode")}
        </Button>
      </div>

      <LiveUpdatesNotice />

      <AgentUpdateAllCard />

      {nodes.isPending ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <NodeCardSkeleton />
          <NodeCardSkeleton />
          <NodeCardSkeleton />
        </div>
      ) : nodes.isError ? (
        <InlineRetry
          message={t("dashboard:nodes.list.loadFailed")}
          onRetry={() => nodes.refetch()}
        />
      ) : nodes.data.nodes.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <Server aria-hidden="true" className="size-6 text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium">{t("dashboard:nodes.list.emptyTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("dashboard:nodes.list.emptyDescription")}
              </p>
            </div>
            <Button className="min-h-[44px]" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              {t("dashboard:nodes.list.addNode")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {nodes.data.nodes.map((node) => (
            <li key={node.id} className="min-w-0">
              <NodeCard node={node} lang={lang} agentUpdate={updateOf(node.id)} />
            </li>
          ))}
        </ul>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <EnrollmentCodesCard />
        <FabricsCard lang={lang} />
      </div>

      <AddNodeDialog open={adding} onOpenChange={setAdding} lang={lang} />
    </div>
  );
}
