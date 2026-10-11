import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { EndpointCard } from "@/components/access/api-endpoint-card";
import { CreateApiKeyDialog } from "@/components/access/create-api-key-dialog";
import { credentialStatus } from "@/components/access/credential-meta";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

/**
 * Welcome step 5: the base URL and a curl example (with your first pool's callable ID), and the
 * Access → API keys dialog, which shows the key once.
 */
export function ApiKeyStep() {
  const { t } = useTranslation(["dashboard", "access"]);
  const queryClient = useQueryClient();
  const keys = useQuery(orpc.access.apiKeys.list.queryOptions());
  const pools = useQuery(orpc.pools.list.queryOptions());
  const [createOpen, setCreateOpen] = useState(false);
  const model = pools.data?.pools[0]?.callableIds[0];
  const now = Date.now();
  const active =
    keys.data?.keys.filter((key) => credentialStatus(key, now) === "active").length ?? 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {keys.isPending ? (
        <Skeleton aria-hidden="true" className="h-40 w-full rounded-xl" />
      ) : keys.isError ? (
        <InlineRetry message={t("access:apiKeys.loadFailed")} onRetry={() => keys.refetch()} />
      ) : (
        <EndpointCard baseUrl={keys.data.baseUrl} model={model} />
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <Button type="button" size="touch" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" />
          {t("access:apiKeys.create")}
        </Button>
        {active > 0 ? (
          <span className="text-sm text-muted-foreground">
            {t("dashboard:welcome.apiKey.existing", { count: active })}
          </span>
        ) : null}
      </div>
      <CreateApiKeyDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          if (!next) void queryClient.invalidateQueries({ queryKey: orpc.activity.overview.key() });
        }}
      />
    </div>
  );
}
