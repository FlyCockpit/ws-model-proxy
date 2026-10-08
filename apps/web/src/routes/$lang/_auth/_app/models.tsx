import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { CopyableCode, CopyButton } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { type PillTone, StatusPill } from "@/components/status-pill";
import { WideContent } from "@/components/wide-content";
import { curlSnippet } from "@/lib/call-snippets";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/models")({
  component: ModelsPage,
});

const STATUS_TONE: Record<"serving" | "starting" | "unavailable", PillTone> = {
  serving: "good",
  starting: "busy",
  unavailable: "muted",
};

function ModelsPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const models = useQuery(orpc.models.list.queryOptions());

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="models" />
      {models.isPending ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : models.isError ? (
        <InlineRetry message={t("dashboard:models.loadFailed")} onRetry={() => models.refetch()} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("dashboard:models.baseUrl")}</CardTitle>
              <CardDescription>{t("dashboard:models.baseUrlHint")}</CardDescription>
            </CardHeader>
            <CardContent>
              <CopyableCode value={models.data.baseUrl} label={t("dashboard:models.copyBaseUrl")} />
            </CardContent>
          </Card>

          {models.data.models.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard:models.emptyTitle")}</CardTitle>
                <CardDescription>{t("dashboard:models.emptyHint")}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link
                  to="/$lang/pools"
                  params={{ lang }}
                  className={buttonVariants({ size: "touch" })}
                >
                  {t("dashboard:models.goToPools")}
                </Link>
              </CardContent>
            </Card>
          ) : (
            <ul className="flex min-w-0 flex-col gap-3">
              {models.data.models.map((model) => (
                <li key={model.callableId}>
                  <Card>
                    <CardContent className="flex min-w-0 flex-col gap-3 pt-4">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <CopyableCode
                          value={model.callableId}
                          label={t("dashboard:models.copyId", { id: model.callableId })}
                        />
                        <StatusPill tone={STATUS_TONE[model.status]}>
                          {t(`dashboard:models.status.${model.status}`)}
                        </StatusPill>
                        <StatusPill tone="info">
                          {t(`dashboard:models.type.${model.type}`)}
                        </StatusPill>
                        {model.external ? (
                          <StatusPill tone="busy">{t("dashboard:models.external")}</StatusPill>
                        ) : null}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {model.owner.you
                          ? t("dashboard:models.yourPool")
                          : t("dashboard:models.sharedBy", {
                              owner: model.owner.email ?? model.owner.slug,
                            })}
                        {model.external ? ` · ${t("dashboard:models.externalHint")}` : ""}
                      </p>
                      <details className="group min-w-0">
                        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium">
                          {t("dashboard:models.snippet")}
                        </summary>
                        <div className="flex min-w-0 items-start gap-1">
                          <WideContent className="flex-1 rounded-md bg-muted">
                            <pre className="p-3 font-mono text-xs">
                              {curlSnippet(models.data.baseUrl, model.callableId, model.type)}
                            </pre>
                          </WideContent>
                          <CopyButton
                            value={curlSnippet(models.data.baseUrl, model.callableId, model.type)}
                            label={t("dashboard:models.copySnippet")}
                          />
                        </div>
                      </details>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
          <p className="text-sm text-muted-foreground">
            {t("dashboard:models.directNote")}{" "}
            <Link to="/$lang/test" params={{ lang }} className="underline underline-offset-4">
              {t("dashboard:models.testLink")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}
