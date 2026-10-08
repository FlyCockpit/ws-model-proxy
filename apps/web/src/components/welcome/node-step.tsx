import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EnrollmentPanel } from "@/components/nodes/enrollment-panel";
import { NodeCard } from "@/components/nodes/node-card";
import type { EnrollmentResult } from "@/components/nodes/node-types";
import { refusalToastOptions } from "@/components/nodes/refusal";
import { orpc } from "@/utils/orpc";

/** Node list refresh while the step is open: a node that enrolls shows up without a reload. */
const NODES_REFRESH_MS = 10_000;

/**
 * Welcome step 1: mint a single-use, one-hour code and show the shared "Add a node" panel
 * (command, countdown, New code, what happens, the node turning green when it connects).
 */
export function NodeStep({
  lang,
  result,
  onResult,
}: {
  lang: string;
  /** Kept by the page, so the command survives moving between steps. */
  result: EnrollmentResult | null;
  onResult: (result: EnrollmentResult) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), refetchInterval: NODES_REFRESH_MS });
  const mint = useMutation({
    ...orpc.nodes.enrollmentCodes.create.mutationOptions(),
    // Owned here: the secret is shown once and never kept in the mutation cache.
    gcTime: 0,
    ...refusalToastOptions(t, "dashboard:nodes.add.failed"),
  });
  const revoke = useMutation({
    ...orpc.nodes.enrollmentCodes.revoke.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const mintCode = async () => {
    const previous = result;
    const created = await mint.mutateAsync({ ttlHours: 1, maxUses: 1 }).catch(() => null);
    if (!created) return;
    onResult(created);
    mint.reset();
    // "New code" retires the code it replaces; nodes that already used it stay.
    if (previous) revoke.mutate({ codeId: previous.code.id });
    await queryClient.invalidateQueries({ queryKey: orpc.nodes.enrollmentCodes.key() });
  };
  const list = nodes.data?.nodes ?? [];

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {nodes.isPending ? (
        <Skeleton aria-hidden="true" className="h-32 w-full rounded-xl" />
      ) : list.length > 0 ? (
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">
            {t("dashboard:welcome.node.yours", { count: list.length })}
          </p>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2">
            {list.slice(0, 4).map((node) => (
              <li key={node.id} className="min-w-0">
                <NodeCard node={node} lang={lang} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result ? (
        <EnrollmentPanel
          result={result}
          lang={lang}
          onNewCode={() => void mintCode()}
          newCodePending={mint.isPending}
        />
      ) : (
        <div className="flex min-w-0 flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">{t("dashboard:welcome.node.intro")}</p>
          <Button
            type="button"
            size="touch"
            disabled={mint.isPending}
            onClick={() => void mintCode()}
          >
            <Plus aria-hidden="true" />
            {mint.isPending
              ? t("dashboard:nodes.add.creating")
              : list.length > 0
                ? t("dashboard:welcome.node.mintAnother")
                : t("dashboard:welcome.node.mint")}
          </Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {t("dashboard:welcome.node.moreOptions")}{" "}
        <Link
          to="/$lang/nodes"
          params={{ lang }}
          className="inline-flex min-h-[44px] items-center underline underline-offset-4"
        >
          {t("dashboard:welcome.node.nodesPage")}
        </Link>
      </p>
    </div>
  );
}
