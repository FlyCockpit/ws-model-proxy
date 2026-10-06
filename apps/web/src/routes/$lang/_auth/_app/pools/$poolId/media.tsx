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
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/media")({
  component: PoolMediaPage,
});

const INPUTS = ["IMAGE", "AUDIO", "VIDEO"] as const;
type Input = (typeof INPUTS)[number];
/** Images and video are described by an LLM pool; audio is transcribed. */
const TARGET_TYPE: Record<Input, PoolView["modelType"]> = {
  IMAGE: "LLM",
  VIDEO: "LLM",
  AUDIO: "TRANSCRIPTION",
};

function PoolMediaPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  const pools = useQuery(orpc.pools.list.queryOptions());
  if (pool.isPending || pools.isPending)
    return <Skeleton className="h-80 w-full rounded-xl" aria-hidden="true" />;
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

function SidecarCard({
  pool,
  input,
  targets,
}: {
  pool: PoolView;
  input: Input;
  targets: Array<{ id: string; label: string }>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const current = pool.sidecars.find((sidecar) => sidecar.input === input);
  const [target, setTarget] = useState(current?.targetPoolId ?? "");
  const [prompt, setPrompt] = useState(current?.prompt ?? "");
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const save = async () => {
    try {
      await update.mutateAsync({
        poolId: pool.id,
        sidecars: [
          target
            ? { input, targetPoolId: target, prompt: prompt.trim() ? prompt.trim() : null }
            : { input, targetPoolId: null },
        ],
      });
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      toast.success(t("dashboard:pool.saved"));
    } catch (error) {
      toast.error(refusalText(error));
    }
  };
  const selectId = `sidecar-${input}`;
  const promptId = `sidecar-prompt-${input}`;
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
            save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={selectId}>{t("dashboard:pool.media.target")}</Label>
            <NativeSelect
              id={selectId}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">{t("dashboard:pool.media.none")}</option>
              {targets.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          {input !== "AUDIO" && target ? (
            <div className="space-y-1.5">
              <Label htmlFor={promptId}>{t("dashboard:pool.media.prompt")}</Label>
              <Textarea
                id={promptId}
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </div>
          ) : null}
          <div>
            <Button type="submit" size="touch" disabled={update.isPending}>
              {t("common:actions.save")}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
