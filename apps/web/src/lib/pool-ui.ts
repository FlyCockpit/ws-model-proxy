import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

import type { PillTone } from "@/components/status-pill";
import { slugify } from "@/lib/slugify";

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

/**
 * A pool slug from a served model's name, suffixed (`-2`, `-3`…)
 * when one of `taken` already uses it.
 */
export function poolSlugFor(model: string, taken: ReadonlySet<string>): string {
  // The last path segment (`Qwen/Qwen3-32B` → `qwen3-32b`) unless it starts with a digit, which
  // a slug cannot (`org/7b-chat` → `org-7b-chat`, not `b-chat`).
  const last = model.split("/").pop() ?? model;
  const base = (/^[a-z]/i.test(last) ? slugify(last) : "") || slugify(model) || "pool";
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 41 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
