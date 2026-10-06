import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { HoldCard, TemporaryCard, TrustCard } from "@/components/nodes/node-control-cards";
import {
  HardwareCard,
  MetricCommandsCard,
  NodeFabricsCard,
  PlacementCard,
} from "@/components/nodes/node-definition-cards";
import { NodeDetailHeader, NodeDetailSkeleton } from "@/components/nodes/node-detail-header";
import {
  CredentialsCard,
  NodeActivityCard,
  RunsHereCard,
  SecretsCard,
} from "@/components/nodes/node-info-cards";
import { isNotFound } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/nodes/$nodeId")({
  component: NodeDetailPage,
});

const NODE_REFRESH_MS = 15_000;

function NodeDetailPage() {
  const { lang, nodeId } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const node = useQuery({
    ...orpc.nodes.get.queryOptions({ input: { nodeId } }),
    refetchInterval: NODE_REFRESH_MS,
  });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link
        to="/$lang/nodes"
        params={{ lang }}
        className="inline-flex min-h-[44px] w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("dashboard:nodes.detail.back")}
      </Link>
      {node.isPending ? (
        <NodeDetailSkeleton />
      ) : node.isError ? (
        <InlineRetry
          message={
            isNotFound(node.error)
              ? t("dashboard:nodes.detail.notFound")
              : t("dashboard:nodes.detail.loadFailed")
          }
          onRetry={() => node.refetch()}
        />
      ) : (
        // Keyed by the node so form defaults reset when another node opens.
        <div key={node.data.id} className="flex min-w-0 flex-col gap-6">
          <NodeDetailHeader node={node.data} lang={lang} />
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <TrustCard node={node.data} />
            <HoldCard node={node.data} />
            <RunsHereCard node={node.data} lang={lang} />
            <HardwareCard node={node.data} lang={lang} />
            <PlacementCard node={node.data} />
            <NodeFabricsCard node={node.data} />
            <MetricCommandsCard node={node.data} />
            <SecretsCard node={node.data} />
            <TemporaryCard node={node.data} />
            <CredentialsCard node={node.data} />
          </div>
          <NodeActivityCard node={node.data} />
        </div>
      )}
    </div>
  );
}
