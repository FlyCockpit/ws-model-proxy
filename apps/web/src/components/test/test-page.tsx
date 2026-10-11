import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { ChatPanel } from "@/components/test/chat-panel";
import { EmbeddingsPanel } from "@/components/test/embeddings-panel";
import { TargetPicker } from "@/components/test/target-picker";
import { TranscriptionPanel } from "@/components/test/transcription-panel";
import { type TestTarget, testKindOf } from "@/lib/test-relay";
import { orpc } from "@/utils/orpc";

/**
 * The Test page (spec §7.3 row 4): chat, embeddings or transcription against a callable ID or
 * one of the person's own served models. `target` (the search param) preselects one, as the
 * Models page's Test links do; changing it replaces the search param.
 */
export function TestPage({
  lang,
  target: requested,
  onTargetChange,
}: {
  lang: string;
  target: string | undefined;
  onTargetChange: (model: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const targets = useQuery(orpc.models.testTargets.queryOptions());

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="test" />
      {targets.isPending ? (
        <TestSkeleton />
      ) : targets.isError ? (
        <InlineRetry message={t("dashboard:test.loadFailed")} onRetry={() => targets.refetch()} />
      ) : targets.data.targets.length === 0 ? (
        <EmptyState lang={lang} />
      ) : (
        <TestBody
          targets={targets.data.targets}
          requested={requested}
          onTargetChange={onTargetChange}
        />
      )}
    </div>
  );
}

function TestBody({
  targets,
  requested,
  onTargetChange,
}: {
  targets: TestTarget[];
  requested: string | undefined;
  onTargetChange: (model: string) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const found = requested ? targets.find((target) => target.model === requested) : undefined;
  // `targets` is non-empty here.
  const selected = found ?? (targets[0] as TestTarget);
  const kind = testKindOf(selected);
  return (
    <>
      <Card>
        <CardContent className="flex min-w-0 flex-col gap-3 pt-4">
          <TargetPicker targets={targets} value={selected.model} onChange={onTargetChange} />
          {requested && !found ? (
            <p className="break-words text-sm text-destructive" role="alert">
              {t("dashboard:test.target.missing", { target: requested })}
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t(`dashboard:test.kind.${kind}.title`)}</CardTitle>
          <CardDescription>{t(`dashboard:test.kind.${kind}.description`)}</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          {/* Keyed by target: a new target starts a new conversation (and ends a live session). */}
          {kind === "chat" ? (
            <ChatPanel key={selected.model} target={selected} />
          ) : kind === "embeddings" ? (
            <EmbeddingsPanel key={selected.model} target={selected} />
          ) : (
            <TranscriptionPanel key={selected.model} target={selected} />
          )}
        </CardContent>
      </Card>
    </>
  );
}

function EmptyState({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:test.emptyTitle")}</CardTitle>
        <CardDescription>{t("dashboard:test.emptyHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Link to="/$lang/welcome" params={{ lang }} className={buttonVariants({ size: "touch" })}>
          {t("dashboard:test.goToWelcome")}
        </Link>
        <Link
          to="/$lang/pools"
          params={{ lang }}
          className={buttonVariants({ variant: "outline", size: "touch" })}
        >
          {t("dashboard:models.goToPools")}
        </Link>
      </CardContent>
    </Card>
  );
}

/** Matches the loaded layout: the target card, then the test card with a composer. */
function TestSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-6" aria-hidden="true" data-testid="test-skeleton">
      <div className="space-y-3 rounded-xl border p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-5 w-1/2" />
      </div>
      <div className="space-y-3 rounded-xl border p-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-11 w-full md:w-80" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}
