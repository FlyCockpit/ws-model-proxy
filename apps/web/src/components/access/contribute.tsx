import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export type Contributing = Awaited<ReturnType<AppRouterClient["access"]["contributing"]["pools"]>>;
type ContributablePool = Contributing["pools"][number];
type ServedModel = Contributing["servedModels"][number];

/**
 * Pools shared with you that can take this model now: can contribute (every listed share), the
 * model's type, not routed to the owner's hardware only, and the model not already in them.
 */
function poolsFor(
  pools: readonly ContributablePool[],
  model: { runtimeModelId: string; type: string },
) {
  return pools.filter(
    (pool) =>
      pool.modelType === model.type &&
      !pool.ownHardwareOnly &&
      !pool.yourMembers.some((member) => member.runtimeModelId === model.runtimeModelId),
  );
}

/** Adds one of your served models to a pool shared with you; refusals are toasted here. */
function useAddContributed() {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.pools.members.addContributed.mutationOptions({
      onSuccess: async () => {
        toast.success(t("access:contributions.added"));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.access.contributing.key() }),
          // A runtime's served models list the pools they are in.
          queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
        ]);
      },
      onError: (error) => toast.error(refusalText(error)),
    }),
    meta: { skipGlobalErrorToast: true },
  });
}

/** Access → Contributing: a pool shared with you, then one of your served models, then Add. */
export function ContributeModelForm({ data }: { data: Contributing }) {
  const { t } = useTranslation(["access", "dashboard"]);
  const add = useAddContributed();
  const open = data.pools.filter((pool) => !pool.ownHardwareOnly);
  const schema = z.object({
    poolId: z.string().min(1, t("access:contributions.choosePool")),
    runtimeModelId: z.string().min(1, t("access:contributions.chooseModel")),
  });
  const form = useForm({
    defaultValues: { poolId: "", runtimeModelId: "" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      const done = await add
        .mutateAsync({ poolId: value.poolId, runtimeModelId: value.runtimeModelId })
        .then(() => true)
        .catch(() => false);
      if (done) formApi.reset();
    },
  });
  if (open.length === 0) return null;
  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      aria-label={t("access:contributions.addTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <form.Field
        name="poolId"
        listeners={{ onChange: () => form.setFieldValue("runtimeModelId", "") }}
      >
        {(field) => (
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="contribute-pool">{t("access:contributions.pool")}</Label>
            <NativeSelect
              id="contribute-pool"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            >
              <option value="">{t("access:contributions.pickPool")}</option>
              {open.map((pool) => (
                <option key={pool.poolId} value={pool.poolId}>
                  {pool.callableId}
                </option>
              ))}
            </NativeSelect>
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.values.poolId}>
        {(poolId) => {
          const pool = open.find((candidate) => candidate.poolId === poolId);
          const models = pool
            ? data.servedModels.filter(
                (model) =>
                  model.type === pool.modelType &&
                  !pool.yourMembers.some(
                    (member) => member.runtimeModelId === model.runtimeModelId,
                  ),
              )
            : [];
          return (
            <form.Field name="runtimeModelId">
              {(field) => (
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="contribute-model">{t("access:contributions.model")}</Label>
                  <NativeSelect
                    id="contribute-model"
                    value={field.state.value}
                    disabled={!pool}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="">{t("access:contributions.pickModel")}</option>
                    {models.map((model) => (
                      <option key={model.runtimeModelId} value={model.runtimeModelId}>
                        {modelLabel(model)}
                      </option>
                    ))}
                  </NativeSelect>
                  {pool && models.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("access:contributions.noMatchingModels", {
                        type: t(`access:modelType.${pool.modelType}`),
                      })}
                    </p>
                  ) : null}
                  <FieldErrors field={field} />
                </div>
              )}
            </form.Field>
          );
        }}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button type="submit" size="touch" className="self-start" disabled={isSubmitting}>
            {isSubmitting ? t("access:contributions.adding") : t("access:contributions.add")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}

function modelLabel(model: ServedModel) {
  return `${model.upstreamModelId} · ${model.runtimeName}`;
}

/**
 * A runtime's served model: add it to a pool shared with you (with can contribute). Renders
 * nothing when no shared pool could take it.
 */
export function AddToSharedPool({
  model,
}: {
  model: { id: string; type: string; retired: boolean };
}) {
  const { t } = useTranslation(["access"]);
  const contributing = useQuery(orpc.access.contributing.pools.queryOptions());
  const add = useAddContributed();
  const [poolId, setPoolId] = useState("");
  const pools = poolsFor(contributing.data?.pools ?? [], {
    runtimeModelId: model.id,
    type: model.type,
  });
  if (model.retired || pools.length === 0) return null;
  const fieldId = `add-to-shared-pool-${model.id}`;
  const chosen = pools.some((pool) => pool.poolId === poolId) ? poolId : "";
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor={fieldId}>{t("access:contributions.addToShared")}</Label>
        <NativeSelect
          id={fieldId}
          value={chosen}
          onChange={(event) => setPoolId(event.target.value)}
        >
          <option value="">{t("access:contributions.pickPool")}</option>
          {pools.map((pool) => (
            <option key={pool.poolId} value={pool.poolId}>
              {t("access:contributions.poolFrom", {
                pool: pool.callableId,
                email: pool.ownerEmail,
              })}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button
        type="button"
        size="touch"
        disabled={!chosen || add.isPending}
        onClick={() =>
          add.mutate(
            { poolId: chosen, runtimeModelId: model.id },
            { onSuccess: () => setPoolId("") },
          )
        }
      >
        {t("access:contributions.add")}
      </Button>
    </div>
  );
}

/** Withdraw one of your contributed members from a pool shared with you. */
export function useWithdrawContributed(onDone: () => void) {
  const { t } = useTranslation(["access"]);
  const queryClient = useQueryClient();
  return useMutation({
    ...orpc.pools.members.removeContributed.mutationOptions({
      onSuccess: async () => {
        onDone();
        toast.success(t("access:contributions.withdrawn"));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.access.contributing.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.pools.key() }),
        ]);
      },
      onError: (error) => toast.error(refusalText(error)),
    }),
    meta: { skipGlobalErrorToast: true },
  });
}
