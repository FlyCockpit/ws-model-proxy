import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { EnrollmentResult } from "@/components/nodes/node-types";
import { PageHeading } from "@/components/page-stub";
import { AgentStep } from "@/components/welcome/agent-step";
import { ApiKeyStep } from "@/components/welcome/api-key-step";
import { NodeStep } from "@/components/welcome/node-step";
import { PoolStep } from "@/components/welcome/pool-step";
import { ServersStep } from "@/components/welcome/servers-step";
import { useMarkWelcomeOffered, usePinWelcomeStep } from "@/hooks/use-welcome-offer";
import {
  nextStep,
  parseWelcomeStep,
  previousStep,
  WELCOME_STEPS,
  type WelcomeProgress,
  type WelcomeStep,
} from "@/lib/welcome-steps";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/welcome")({
  validateSearch: (search: Record<string, unknown>): { step?: WelcomeStep } => {
    const step = parseWelcomeStep(search.step);
    return step ? { step } : {};
  },
  component: WelcomePage,
});

/** Done-ness refresh while Welcome is open (a node enrolling, a key made in another tab). */
const PROGRESS_REFRESH_MS = 10_000;

function WelcomePage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch();
  const { t } = useTranslation(["dashboard"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useMarkWelcomeOffered();
  // The Overview's summary (same key): its getting-started state is what the checklist shows.
  const summary = useQuery({
    ...orpc.activity.overview.summary.queryOptions({ input: { range: "24h" } }),
    refetchInterval: PROGRESS_REFRESH_MS,
  });
  const complete = useMutation(orpc.settings.onboarding.complete.mutationOptions());
  const progress = summary.data?.onboarding.steps;
  usePinWelcomeStep(lang, search.step, progress);
  // The minted install command outlives step changes (its code stays valid for an hour).
  const [enrollment, setEnrollment] = useState<EnrollmentResult | null>(null);
  // Until a step is in the URL the step card is a skeleton (a failed summary means step 1).
  const current: WelcomeStep = search.step ?? "node";
  const pinned = search.step !== undefined || summary.isError;
  const index = WELCOME_STEPS.indexOf(current);
  const back = previousStep(current);
  const next = nextStep(current);

  const goTo = (step: WelcomeStep) =>
    navigate({ to: "/$lang/welcome", params: { lang }, search: { step } });
  // Skip setup and Finish both end getting started: the Overview checklist goes away.
  const finish = async () => {
    // A failure is toasted by the global mutation error handler; stay on the page.
    const done = await complete.mutateAsync({}).then(
      () => true,
      () => false,
    );
    if (!done) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.activity.overview.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.settings.get.key() }),
    ]);
    await navigate({ to: "/$lang/overview", params: { lang } });
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="welcome" />
        <Button
          type="button"
          variant="ghost"
          size="touch"
          disabled={complete.isPending}
          onClick={() => void finish()}
        >
          {t("dashboard:welcome.skipSetup")}
        </Button>
      </div>

      {summary.isPending ? (
        <StepperSkeleton />
      ) : (
        <Stepper lang={lang} current={current} progress={progress} />
      )}

      {pinned ? (
        <Card className="min-w-0">
          <CardHeader>
            <p className="text-xs font-medium text-muted-foreground">
              {t("dashboard:welcome.stepOf", { step: index + 1, total: WELCOME_STEPS.length })}
            </p>
            <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-lg">
              <h2>{t(`dashboard:welcome.${current}.title`)}</h2>
              {progress?.[current] ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-state-success-bg px-2 py-0.5 text-xs font-medium text-state-success">
                  <Check aria-hidden="true" className="size-3.5" />
                  {t("dashboard:welcome.done")}
                </span>
              ) : null}
            </CardTitle>
            <CardDescription>{t(`dashboard:welcome.${current}.description`)}</CardDescription>
          </CardHeader>
          <CardContent className="min-w-0">
            <StepBody
              step={current}
              lang={lang}
              enrollment={enrollment}
              onEnrollment={setEnrollment}
            />
          </CardContent>
          <CardFooter className="flex min-w-0 flex-wrap justify-between gap-2">
            {back ? (
              <Button type="button" variant="ghost" size="touch" onClick={() => void goTo(back)}>
                <ArrowLeft aria-hidden="true" />
                {t("dashboard:welcome.back")}
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button
                type="button"
                variant={progress?.[current] ? "default" : "outline"}
                size="touch"
                onClick={() => void goTo(next)}
              >
                {progress?.[current]
                  ? t("dashboard:welcome.continue")
                  : t("dashboard:welcome.skip")}
                <ArrowRight aria-hidden="true" />
              </Button>
            ) : (
              <Button
                type="button"
                size="touch"
                disabled={complete.isPending}
                onClick={() => void finish()}
              >
                {t("dashboard:welcome.finish")}
                <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </CardFooter>
        </Card>
      ) : (
        <Skeleton aria-hidden="true" className="h-72 w-full rounded-xl" />
      )}
    </div>
  );
}

function StepBody({
  step,
  lang,
  enrollment,
  onEnrollment,
}: {
  step: WelcomeStep;
  lang: string;
  enrollment: EnrollmentResult | null;
  onEnrollment: (result: EnrollmentResult) => void;
}) {
  switch (step) {
    case "node":
      return <NodeStep lang={lang} result={enrollment} onResult={onEnrollment} />;
    case "runtime":
      return <ServersStep lang={lang} />;
    case "pool":
      return <PoolStep lang={lang} />;
    case "agent":
      return <AgentStep />;
    case "apiKey":
      return <ApiKeyStep />;
  }
}

/** The five steps as links (`?step=`), each checked once the Overview counts it done. */
function Stepper({
  lang,
  current,
  progress,
}: {
  lang: string;
  current: WelcomeStep;
  progress: WelcomeProgress | undefined;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <nav aria-label={t("dashboard:welcome.stepsLabel")} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap gap-x-2 gap-y-1">
        {WELCOME_STEPS.map((step, index) => {
          const done = progress?.[step] === true;
          const active = step === current;
          return (
            <li key={step} className="min-w-0">
              <Link
                to="/$lang/welcome"
                params={{ lang }}
                search={{ step }}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "inline-flex min-h-[44px] min-w-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted",
                  active && "bg-muted font-medium",
                )}
              >
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full text-xs font-medium",
                    done
                      ? "bg-state-success-bg text-state-success"
                      : "border border-primary/40 text-primary",
                  )}
                >
                  {done ? <Check aria-hidden="true" className="size-3.5" /> : index + 1}
                </span>
                <span className={cn("truncate", done && !active && "text-muted-foreground")}>
                  {t(`dashboard:welcome.${step}.title`)}
                </span>
                {done ? <span className="sr-only">{t("dashboard:welcome.doneSr")}</span> : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepperSkeleton() {
  return (
    <div className="flex min-w-0 flex-wrap gap-2" aria-hidden="true">
      {WELCOME_STEPS.map((step) => (
        <Skeleton key={step} className="h-11 w-36 rounded-md" />
      ))}
    </div>
  );
}
