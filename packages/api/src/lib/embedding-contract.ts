import { z } from "zod";

/** Identity of a vector space; dimensions alone never establish compatibility. */
export const embeddingContractSchema = z
  .object({
    model: z.string().trim().min(1).max(256),
    revision: z.string().trim().min(1).max(256),
    dimensions: z.number().int().positive().max(1_000_000),
    normalization: z.enum(["none", "l2"]),
    vectorSpace: z.string().trim().min(1).max(256),
  })
  .strict();

export type EmbeddingContract = z.infer<typeof embeddingContractSchema>;

export function parseEmbeddingContract(value: unknown): EmbeddingContract | null {
  const parsed = embeddingContractSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function embeddingContractsMatch(left: unknown, right: unknown): boolean {
  const a = parseEmbeddingContract(left);
  const b = parseEmbeddingContract(right);
  return Boolean(
    a &&
      b &&
      a.model === b.model &&
      a.revision === b.revision &&
      a.dimensions === b.dimensions &&
      a.normalization === b.normalization &&
      a.vectorSpace === b.vectorSpace,
  );
}
