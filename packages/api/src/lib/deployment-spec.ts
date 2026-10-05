import {
  DEPLOYMENT_COMMAND_MAX_BYTES,
  deploymentCommandBytes,
} from "@ws-model-proxy/config/deployment-protocol";
import { z } from "zod";
import { embeddingContractSchema } from "./embedding-contract";
import { nodeLabelsSchema } from "./node-inventory";

/** Placeholders a command may use; anything else is refused when the recipe is saved. */
export const DEPLOYMENT_PLACEHOLDERS = [
  "node_rank",
  "nnodes",
  "port",
  "dist_port",
  "memory_gb",
  "gpu_ids",
  "vram_gb",
  "memory_fraction",
  "iface",
  "head_addr",
] as const;
const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;
/**
 * Code points that are invisible, reorder text, or look like a plain space:
 * controls (except TAB and LF), format characters (bidi, isolates, zero-width,
 * tags), every default-ignorable code point, and non-ASCII spaces. Reviewed
 * text must not display differently from what runs.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zs}\p{Zl}\p{Zp}\u2800]/u;
export function isHiddenCodePoint(codePoint: number): boolean {
  // TAB, LF and the ASCII space are the visible whitespace commands use.
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x20) return false;
  return HIDDEN.test(String.fromCodePoint(codePoint));
}
function hasHiddenCharacter(value: string): boolean {
  for (const char of value) if (isHiddenCodePoint(char.codePointAt(0) ?? 0)) return true;
  return false;
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/**
 * Text that is stored and shown for human review: no hidden or reordering
 * characters, and well-formed (PostgreSQL refuses NUL and lone surrogates).
 */
export function deploymentTextIssue(value: string): string | null {
  if (LONE_SURROGATE.test(value)) return "Text must be valid Unicode.";
  if (hasHiddenCharacter(value))
    return "Text must not contain control or bidirectional formatting characters.";
  return null;
}
export const deploymentTextSchema = (max: number) =>
  z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      const issue = deploymentTextIssue(value);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    });
// A UTF-16 length cap first (never below the byte count), then the exact UTF-8 byte limit the
// CLI enforces, so no saved command can be one the node always refuses.
const command = deploymentTextSchema(DEPLOYMENT_COMMAND_MAX_BYTES)
  .refine((value) => !!value.trim(), "Command must not be blank.")
  .refine(
    (value) => deploymentCommandBytes(value) <= DEPLOYMENT_COMMAND_MAX_BYTES,
    `Command must be at most ${DEPLOYMENT_COMMAND_MAX_BYTES} bytes.`,
  )
  .superRefine((value, ctx) => {
    for (const [, key] of value.matchAll(PLACEHOLDER)) {
      if (!(DEPLOYMENT_PLACEHOLDERS as readonly string[]).includes(key ?? ""))
        ctx.addIssue({ code: "custom", message: `Unknown placeholder {{${key}}}.` });
    }
  });
/** A row id named by a caller (cuid, uuid): never free text that reaches SQL as-is. */
export const deploymentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** A served model id exactly as the relay normalizes it: trimmed, single-line. */
const modelId = deploymentTextSchema(256)
  .refine((value) => value.length > 0 && value.trim() === value, {
    message: "Model ids must not be blank or have leading or trailing spaces.",
  })
  .refine((value) => !/[\n\t]/.test(value), "Model ids must be a single line.");
/** An embedding contract as saved in a recipe: its text follows the recipe rules. */
const savedEmbeddingContract = embeddingContractSchema.superRefine((contract, ctx) => {
  for (const key of ["model", "revision", "vectorSpace"] as const) {
    const issue = deploymentTextIssue(contract[key]);
    if (issue) ctx.addIssue({ code: "custom", path: [key], message: issue });
  }
});
// Historical *Gb API names measure GiB (2^30 bytes), matching node budgets.
const gb = z.number().finite().positive().max(1_000_000).describe("Memory in GiB (2^30 bytes).");
export const deploymentResourcesSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unified"), memoryGb: gb }).strict(),
  z.object({ kind: z.literal("cpu"), ramGb: gb }).strict(),
  z
    .object({
      kind: z.literal("discrete"),
      gpuCount: z.number().int().min(1).max(256),
      vramGb: gb,
      ramGb: gb.optional(),
    })
    .strict(),
]);
/**
 * The recipe schema. `strict` holds every rule for text a person or agent
 * saves; the lenient form keeps the same shape for reading revisions that were
 * stored before the current text rules, so existing instances keep running.
 */
function variantSchema(strict: boolean) {
  const commandText = strict
    ? command
    : // Older revisions stay readable; rendering refuses a command over the CLI's byte limit.
      z
        .string()
        .min(1)
        .max(32_768)
        .refine((value) => !!value.trim(), "Command must not be blank.");
  return z
    .object({
      key: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
      engine: z.enum(["vllm", "sglang", "llama.cpp", "other"]).default("other"),
      labels: nodeLabelsSchema.default([]),
      groupSize: z.number().int().min(1).max(64),
      resources: z.array(deploymentResourcesSchema).min(1).max(64),
      commands: z
        .array(
          z
            .object({
              management: z.enum(["ownedProcess", "externalService"]),
              start: commandText,
              stop: commandText,
              prepare: commandText.optional(),
              afterJoin: commandText.optional(),
              status: commandText.optional(),
              health: commandText.optional(),
            })
            .strict()
            .refine(
              (commands) => commands.management !== "externalService" || !!commands.status?.trim(),
              "External services require a reliable status command (exit 0 alive, exit 3 stopped).",
            ),
        )
        .min(1)
        .max(64),
      readiness: z
        .object({
          path: (strict ? deploymentTextSchema(2048) : z.string().max(2048))
            .regex(/^\/[^\r\n]*$/)
            .default("/health"),
          expectedStatus: z.number().int().min(200).max(399).default(200),
          timeoutMs: z.number().int().min(1000).max(900_000).default(900_000),
        })
        .strict(),
      health: z
        .object({
          intervalMs: z.number().int().min(5000).max(300_000).default(30_000),
          failureThreshold: z.number().int().min(1).max(20).default(3),
          successThreshold: z.number().int().min(1).max(20).default(1),
        })
        .strict()
        .default({ intervalMs: 30_000, failureThreshold: 3, successThreshold: 1 }),
      models: z
        .array(strict ? modelId : z.string().min(1).max(256))
        .min(1)
        .max(64),
      attachment: z
        .object({
          type: z.enum(["llm", "embeddings"]),
          poolId: strict ? deploymentIdSchema : z.string().min(1),
          embeddingContract: (strict ? savedEmbeddingContract : embeddingContractSchema).optional(),
        })
        .strict()
        .refine(
          (a) => a.type === "embeddings" || !a.embeddingContract,
          "Embedding contracts require an embedding attachment.",
        ),
      weight: z.number().int().min(1).max(1000).default(1),
      hardConcurrencyLimit: z.number().int().min(1).max(10_000),
      contextWindow: z.number().int().positive().max(100_000_000).nullable().default(null),
      iface: z
        .string()
        .regex(/^[a-zA-Z0-9_.:-]{1,64}$/)
        .optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      for (const key of ["resources", "commands"] as const) {
        if (v[key].length !== 1 && v[key].length !== v.groupSize)
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "Provide one default or exactly one entry per rank.",
          });
      }
      if (v.groupSize > 1 && !v.iface)
        ctx.addIssue({
          code: "custom",
          path: ["iface"],
          message: "Multi-node deployments require a network interface.",
        });
    });
}
export const deploymentVariantSchema = variantSchema(true);
export const storedDeploymentVariantSchema = variantSchema(false);
function specSchema(
  variant: typeof deploymentVariantSchema | typeof storedDeploymentVariantSchema,
) {
  return z
    .object({ variants: z.array(variant).min(1).max(32) })
    .strict()
    .superRefine((spec, ctx) => {
      if (new Set(spec.variants.map((v) => v.key)).size !== spec.variants.length)
        ctx.addIssue({
          code: "custom",
          path: ["variants"],
          message: "Variant keys must be unique.",
        });
    });
}
/** Validates a recipe being saved or started. */
export const deploymentSpecSchema = specSchema(deploymentVariantSchema);
/** Reads a stored revision for an instance that already exists. */
export const storedDeploymentSpecSchema = specSchema(storedDeploymentVariantSchema);
export type DeploymentVariant = z.infer<typeof deploymentVariantSchema>;
export type DeploymentResources = z.infer<typeof deploymentResourcesSchema>;
export type DeploymentClaim = {
  kind: "unified" | "cpu" | "discrete";
  memoryGb: number;
  ramGb: number;
  gpus: Array<{ key: string; index: number; vramGb: number }>;
};
export const deploymentClaimSchema = z.object({
  kind: z.enum(["unified", "cpu", "discrete"]),
  memoryGb: z.number().nonnegative(),
  ramGb: z.number().nonnegative(),
  gpus: z.array(
    z.object({ key: z.string(), index: z.number().int(), vramGb: z.number().nonnegative() }),
  ),
});
export function rankValue<T>(values: readonly T[], rank: number): T {
  const value = values.length === 1 ? values[0] : values[rank];
  if (!value) throw new Error("Missing rank configuration");
  return value;
}

export {
  deploymentDerivedIntents,
  deploymentHealthIntent,
  deploymentJobIntentSchema,
  originalDeploymentStopIntent,
} from "./deployment-job-intent";
