import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/media")({
  component: PoolMediaPage,
});

const INPUTS = ["IMAGE", "AUDIO", "VIDEO"] as const;
type MediaInput = (typeof INPUTS)[number];
/** Images and video are described by an LLM pool; audio is transcribed. */
const TARGET_TYPE: Record<MediaInput, PoolView["modelType"]> = {
  IMAGE: "LLM",
  VIDEO: "LLM",
  AUDIO: "TRANSCRIPTION",
};
/** `pools.update` sidecar bounds (contracts/pools.ts): the timeout is shown in seconds. */
const TIMEOUT_S = { min: 1, max: 600 } as const;
const MAX_ASSETS = { min: 1, max: 64 } as const;

function PoolMediaPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  const pools = useQuery(orpc.pools.list.queryOptions());
  if (pool.isPending || pools.isPending)
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-16 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  if (pool.isError || pools.isError)
    return (
      <InlineRetry
        message={t("dashboard:pool.loadFailed")}
        onRetry={() => {
          pool.refetch();
          pools.refetch();
        }}
      />
    );
  const targets = [
    ...pools.data.pools.map((other) => ({
      id: other.id,
      label: other.callableIds[0] ?? other.name,
      type: other.modelType,
    })),
    ...pools.data.sharedWithMe
      .filter((shared) => shared.canUse)
      .map((shared) => ({
        id: shared.poolId,
        label: shared.callableIds[0] ?? shared.poolId,
        type: shared.modelType,
      })),
  ].filter((target) => target.id !== pool.data.id);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("dashboard:pool.media.intro")}</p>
      <PipelineStrip pool={pool.data} />
      {INPUTS.map((input) => (
        <SidecarCard
          key={input}
          pool={pool.data}
          input={input}
          targets={targets.filter((target) => target.type === TARGET_TYPE[input])}
        />
      ))}
    </div>
  );
}

/** Media → sidecar pool → this pool, for each input that has a sidecar. */
function PipelineStrip({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard"]);
  const self = pool.callableIds[0] ?? pool.name;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.media.pipeline")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="flex min-w-0 flex-col gap-2" aria-label={t("dashboard:pool.media.pipeline")}>
          {INPUTS.map((input) => {
            const sidecar = pool.sidecars.find((entry) => entry.input === input);
            return (
              <li key={input} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <StatusPill tone={sidecar ? "info" : "muted"}>
                  {t(`dashboard:pool.media.inputs.${input}`)}
                </StatusPill>
                <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                {sidecar ? (
                  <>
                    <code className="min-w-0 break-all font-mono text-xs">
                      {sidecar.targetCallableId}
                    </code>
                    <span className="text-xs text-muted-foreground">
                      {t(`dashboard:pool.media.as.${input}`)}
                    </span>
                    <ArrowRight
                      aria-hidden="true"
                      className="size-4 shrink-0 text-muted-foreground"
                    />
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t("dashboard:pool.media.direct")}
                  </span>
                )}
                <code className="min-w-0 break-all font-mono text-xs">{self}</code>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

/** "" = automatic; otherwise a whole number in [min, max]. */
function optionalInt(bounds: { min: number; max: number }, message: string) {
  return z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" ||
        (/^\d{1,6}$/.test(value) && Number(value) >= bounds.min && Number(value) <= bounds.max),
      message,
    );
}

function SidecarCard({
  pool,
  input,
  targets,
}: {
  pool: PoolView;
  input: MediaInput;
  targets: Array<{ id: string; label: string }>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const current = pool.sidecars.find((sidecar) => sidecar.input === input);
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: {
      target: current?.targetPoolId ?? "",
      prompt: current?.prompt ?? "",
      timeoutS: current?.timeoutMs ? String(Math.round(current.timeoutMs / 1000)) : "",
      maxAssets: current?.maxAssets ? String(current.maxAssets) : "",
    },
    validators: {
      onSubmit: z.object({
        target: z.string(),
        prompt: z.string().max(8_000),
        timeoutS: optionalInt(TIMEOUT_S, t("dashboard:pool.media.rangeInvalid", TIMEOUT_S)),
        maxAssets: optionalInt(MAX_ASSETS, t("dashboard:pool.media.rangeInvalid", MAX_ASSETS)),
      }),
    },
    onSubmit: async ({ value }) => {
      const prompt = value.prompt.trim();
      const timeoutS = value.timeoutS.trim();
      const maxAssets = value.maxAssets.trim();
      try {
        await update.mutateAsync({
          poolId: pool.id,
          sidecars: [
            value.target
              ? {
                  input,
                  targetPoolId: value.target,
                  prompt: input !== "AUDIO" && prompt ? prompt : null,
                  timeoutMs: timeoutS ? Number(timeoutS) * 1000 : null,
                  maxAssets: maxAssets ? Number(maxAssets) : null,
                }
              : { input, targetPoolId: null },
          ],
        });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
        toast.success(t("dashboard:pool.saved"));
      } catch (error) {
        toast.error(refusalText(error));
      }
    },
  });
  const selectId = `sidecar-${input}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t(`dashboard:pool.media.inputs.${input}`)}</CardTitle>
        <CardDescription>{t(`dashboard:pool.media.hints.${input}`)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="target">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor={selectId}>{t("dashboard:pool.media.target")}</Label>
                <NativeSelect
                  id={selectId}
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                >
                  <option value="">{t("dashboard:pool.media.none")}</option>
                  {current && !targets.some((option) => option.id === current.targetPoolId) ? (
                    <option value={current.targetPoolId}>
                      {t("dashboard:pool.media.unavailable", { id: current.targetCallableId })}
                    </option>
                  ) : null}
                  {targets.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.target}>
            {(target) =>
              target ? (
                <>
                  {input !== "AUDIO" ? (
                    <form.Field name="prompt">
                      {(field) => (
                        <div className="space-y-1.5">
                          <Label htmlFor={`sidecar-prompt-${input}`}>
                            {t("dashboard:pool.media.prompt")}
                          </Label>
                          <Textarea
                            id={`sidecar-prompt-${input}`}
                            rows={3}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          <FieldErrors field={field} />
                        </div>
                      )}
                    </form.Field>
                  ) : null}
                  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                    <form.Field name="timeoutS">
                      {(field) => (
                        <div className="min-w-0 space-y-1.5">
                          <Label htmlFor={`sidecar-timeout-${input}`}>
                            {t("dashboard:pool.media.timeout")}
                          </Label>
                          <Input
                            id={`sidecar-timeout-${input}`}
                            className="h-11 tabular-nums"
                            inputMode="numeric"
                            placeholder={t("dashboard:pool.media.automatic")}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          <FieldErrors field={field} />
                        </div>
                      )}
                    </form.Field>
                    <form.Field name="maxAssets">
                      {(field) => (
                        <div className="min-w-0 space-y-1.5">
                          <Label htmlFor={`sidecar-max-assets-${input}`}>
                            {t(`dashboard:pool.media.maxAssets.${input}`)}
                          </Label>
                          <Input
                            id={`sidecar-max-assets-${input}`}
                            className="h-11 tabular-nums"
                            inputMode="numeric"
                            placeholder={t("dashboard:pool.media.automatic")}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                          <FieldErrors field={field} />
                        </div>
                      )}
                    </form.Field>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:pool.media.limitsHint")}
                  </p>
                </>
              ) : null
            }
          </form.Subscribe>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <div>
                <Button type="submit" size="touch" disabled={submitting || update.isPending}>
                  {submitting ? t("common:actions.saving") : t("common:actions.save")}
                </Button>
              </div>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}
