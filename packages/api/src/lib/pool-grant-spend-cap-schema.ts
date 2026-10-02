import { z } from "zod";

/** Owner-paid `:external` spend cap keyed by pool + grantee (survives re-grant). */
export const poolGrantSpendCapSchema = z
  .object({
    limit: z.string().regex(/^(?:0|[1-9]\d{0,20})(?:\.\d{1,9})?$/u),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    period: z.enum(["UTC_DAY", "UTC_MONTH"]),
  })
  .superRefine((value, context) => {
    const amount = Number(value.limit);
    if (!(amount > 0) || amount >= 1e21) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Spend cap must be positive",
        path: ["limit"],
      });
    }
  });

export type PoolGrantSpendCap = z.infer<typeof poolGrantSpendCapSchema>;
