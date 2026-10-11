import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { TimeAgo } from "@/components/time-ago";
import { orpc } from "@/utils/orpc";

import { StatusPill } from "./node-badges";
import type { EnrollmentCode } from "./node-types";
import { refusalToastOptions } from "./refusal";

function codeState(code: EnrollmentCode, now: number): "live" | "used" | "expired" | "revoked" {
  if (code.revokedAt) return "revoked";
  if (code.usedCount >= code.maxUses) return "used";
  if (new Date(code.expiresAt).getTime() <= now) return "expired";
  return "live";
}

/** Enrollment codes: what is still usable, who used it, revoke. */
export function EnrollmentCodesCard() {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const codes = useQuery(orpc.nodes.enrollmentCodes.list.queryOptions());
  const revoke = useMutation({
    ...orpc.nodes.enrollmentCodes.revoke.mutationOptions({
      onSuccess: () => {
        toast.success(t("dashboard:nodes.codes.revoked"));
        queryClient.invalidateQueries({ queryKey: orpc.nodes.enrollmentCodes.key() });
      },
    }),
    ...refusalToastOptions(t),
  });
  const now = Date.now();

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:nodes.codes.title")}</CardTitle>
        <CardDescription>{t("dashboard:nodes.codes.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {codes.isPending ? (
          <div aria-hidden="true" className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : codes.isError ? (
          <InlineRetry onRetry={() => codes.refetch()} />
        ) : codes.data.codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:nodes.codes.empty")}</p>
        ) : (
          <ul className="divide-y">
            {codes.data.codes.map((code) => {
              const state = codeState(code, now);
              return (
                <li key={code.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <code className="font-mono">wsmp_enr_{code.codePrefix}…</code>
                      <StatusPill
                        tone={state === "live" ? "success" : state === "used" ? "info" : "muted"}
                      >
                        {t(`dashboard:nodes.codes.state.${state}`)}
                      </StatusPill>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("dashboard:nodes.codes.uses", { used: code.usedCount, max: code.maxUses })}
                      {" · "}
                      {state === "live"
                        ? t("dashboard:nodes.codes.expires")
                        : t("dashboard:nodes.codes.created")}{" "}
                      <TimeAgo value={state === "live" ? code.expiresAt : code.createdAt} />
                      {code.labels.length > 0
                        ? ` · ${t("dashboard:nodes.codes.labels", { labels: code.labels.join(", ") })}`
                        : null}
                      {code.removeAfterOfflineMs !== null
                        ? ` · ${t("dashboard:nodes.temporary.badge")}`
                        : null}
                      {code.replaceNodeId ? ` · ${t("dashboard:nodes.codes.replace")}` : null}
                    </p>
                    {code.enrolled.length > 0 ? (
                      <p className="text-xs">
                        {t("dashboard:nodes.codes.enrolled", {
                          slugs: code.enrolled
                            .map((use) => use.slug ?? t("dashboard:nodes.codes.deletedNode"))
                            .join(", "),
                        })}
                      </p>
                    ) : null}
                  </div>
                  {state === "live" ? (
                    <Button
                      variant="outline"
                      className="min-h-[44px]"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate({ codeId: code.id })}
                    >
                      {t("dashboard:nodes.codes.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
