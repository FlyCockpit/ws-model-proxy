import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

import type { PillTone } from "@/components/status-pill";

export type PoolsList = Awaited<ReturnType<AppRouterClient["pools"]["list"]>>;
export type PoolView = PoolsList["pools"][number];
export type PoolMemberView = PoolView["members"][number];
export type RuntimeSummary = Awaited<
  ReturnType<AppRouterClient["runtimes"]["list"]>
>["runtimes"][number];
export type ModelType = PoolView["modelType"];

export const MODEL_TYPES = ["LLM", "EMBEDDINGS", "TRANSCRIPTION"] as const;

export const MEMBER_STATUS_TONE: Record<PoolMemberView["status"], PillTone> = {
  serving: "good",
  starting: "busy",
  unavailable: "muted",
  disabled: "muted",
  cloud_standby: "info",
};

/** Served models of your runtimes as pool member choices (value `runtimeId::model`). */
export function servedModelChoices(runtimes: readonly RuntimeSummary[], type: ModelType) {
  return runtimes
    .filter((runtime) => runtime.modelType === type)
    .flatMap((runtime) =>
      runtime.models.map((model) => ({
        value: `${runtime.id}::${model}`,
        label: `${runtime.name} · ${model}`,
        runtimeId: runtime.id,
        model,
      })),
    );
}

/** Splits a `runtimeId::model` choice. */
export function parseMemberChoice(value: string): { runtimeId: string; model: string } | null {
  const index = value.indexOf("::");
  if (index <= 0) return null;
  const model = value.slice(index + 2);
  return model ? { runtimeId: value.slice(0, index), model } : null;
}
