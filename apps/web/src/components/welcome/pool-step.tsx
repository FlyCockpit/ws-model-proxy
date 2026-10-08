import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CopyableCode } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { NewPoolDialog, type NewPoolInitial } from "@/components/pools/new-pool-dialog";
import { StatusPill } from "@/components/status-pill";
import { useCreatePool } from "@/hooks/use-create-pool";
import { MODEL_TYPES, type ModelType, poolSlugFor, servedModelChoices } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

type Choice = ReturnType<typeof servedModelChoices>[number] & { type: ModelType };

/**
 * Welcome step 3: one click turns a served model into a pool (slug from the model name, Local
 * only), then shows the callable ID. "New pool" opens the Pools dialog for anything else.
 */
export function PoolStep({ lang }: { lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const pools = useQuery(orpc.pools.list.queryOptions());
  const { create } = useCreatePool();
  const [creating, setCreating] = useState<string | null>(null);
  const [dialog, setDialog] = useState<NewPoolInitial | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (runtimes.isPending || pools.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-hidden="true">
        <Skeleton className="h-14 w-full rounded-lg" />
        <Skeleton className="h-14 w-full rounded-lg" />
      </div>
    );
  }
  if (runtimes.isError || pools.isError) {
    return (
      <InlineRetry
        message={t("dashboard:welcome.pool.loadFailed")}
        onRetry={() => {
          void runtimes.refetch();
          void pools.refetch();
        }}
      />
    );
  }

  const own = pools.data.pools;
  const taken = new Set(own.map((pool) => pool.slug));
  const pooled = new Set(
    own.flatMap((pool) =>
      pool.members.map((member) => `${member.runtimeId ?? ""}::${member.upstreamModelId}`),
    ),
  );
  const choices: Choice[] = MODEL_TYPES.flatMap((type) =>
    servedModelChoices(runtimes.data.runtimes, type).map((choice) => ({ ...choice, type })),
  ).filter((choice) => !pooled.has(choice.value));

  const createFrom = async (choice: Choice, slug: string) => {
    setCreating(choice.value);
    try {
      await create({
        name: choice.model.slice(0, 120),
        slug,
        type: choice.type,
        members: [{ runtimeId: choice.runtimeId, model: choice.model }],
      });
      toast.success(t("dashboard:pool.created"));
    } catch (error) {
      toast.error(refusalText(error, t("dashboard:pool.createFailed")));
    } finally {
      setCreating(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {own.length > 0 ? (
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{t("dashboard:welcome.pool.callable")}</p>
          <ul className="flex min-w-0 flex-col gap-2">
            {own.map((pool) => (
              <li key={pool.id} className="flex min-w-0 flex-wrap items-center gap-2">
                {pool.callableIds.map((id) => (
                  <CopyableCode key={id} value={id} label={t("dashboard:models.copyId", { id })} />
                ))}
                <Link
                  to="/$lang/pools/$poolId"
                  params={{ lang, poolId: pool.id }}
                  className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                >
                  {t("dashboard:runtime.openPool")}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {choices.length > 0 ? (
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{t("dashboard:welcome.pool.fromModel")}</p>
          <ul className="flex min-w-0 flex-col divide-y rounded-lg border">
            {choices.map((choice) => {
              const slug = poolSlugFor(choice.model, taken);
              return (
                <li
                  key={choice.value}
                  className="flex min-w-0 flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="break-all font-mono text-sm">{choice.label}</span>
                    <StatusPill tone="info">{t(`dashboard:models.type.${choice.type}`)}</StatusPill>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      size="touch"
                      disabled={creating !== null}
                      onClick={() => void createFrom(choice, slug)}
                    >
                      {t("dashboard:welcome.pool.createNamed", { slug })}
                    </Button>
                    <Button
                      type="button"
                      size="touch"
                      variant="outline"
                      disabled={creating !== null}
                      onClick={() => {
                        setDialog({
                          name: choice.model.slice(0, 120),
                          slug,
                          type: choice.type,
                          member: choice.value,
                        });
                        setDialogOpen(true);
                      }}
                    >
                      {t("dashboard:welcome.pool.customize")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {own.length > 0
            ? t("dashboard:welcome.pool.allPooled")
            : t("dashboard:welcome.pool.noModels")}
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="touch"
        className="self-start"
        onClick={() => {
          setDialog(null);
          setDialogOpen(true);
        }}
      >
        <Plus aria-hidden="true" />
        {t("dashboard:pool.new")}
      </Button>
      <NewPoolDialog
        // A fresh form for each prefill.
        key={dialog?.member ?? "blank"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        lang={lang}
        initial={dialog ?? undefined}
        onCreated={() => setDialog(null)}
      />
    </div>
  );
}
