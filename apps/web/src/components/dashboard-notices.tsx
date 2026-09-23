import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { useTranslation } from "react-i18next";

import { orpc } from "@/utils/orpc";

export function DashboardNotices() {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const notices = useQuery(orpc.forwarderManagement.listDashboardNotices.queryOptions());
  const dismiss = useMutation(
    orpc.forwarderManagement.dismissDashboardNotice.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: orpc.forwarderManagement.listDashboardNotices.key(),
        });
      },
    }),
  );
  const rows = (notices.data ?? []).filter((notice) => notice.kind === "POOL_EXTERNAL_PROVIDER");
  if (rows.length === 0) return null;
  return (
    <div className="mb-4 min-w-0 space-y-2" role="region" aria-label={t("notices.region")}>
      {rows.map((notice) => (
        <div
          key={notice.id}
          className="flex min-w-0 flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 sm:flex-row sm:items-center"
          role="status"
        >
          <p className="min-w-0 flex-1 break-words text-sm text-amber-950 dark:text-amber-100">
            {t("notices.poolExternalProvider", { pool: notice.poolName })}
          </p>
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={dismiss.isPending}
            onClick={() => dismiss.mutate({ id: notice.id })}
          >
            {t("notices.dismiss")}
          </Button>
        </div>
      ))}
    </div>
  );
}
