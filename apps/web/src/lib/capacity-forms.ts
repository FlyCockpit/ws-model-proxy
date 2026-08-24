import { z } from "zod";

export const capacityCountStrategies = [
  "CONSERVATIVE_ESTIMATE",
  "ENGINE_REPORTED",
  "TOKENIZER",
  "TEMPLATE_AWARE",
] as const;

export const capacityFormSchema = z.object({
  label: z.string().trim().min(1).max(120),
  runtimeModel: z.string().trim().min(1).max(500),
  runtimeIdentityKey: z.string().trim().min(1).max(500),
  hardConcurrencyLimit: z.number().int().min(1).max(10_000),
  physicalMaxContext: z.number().int().min(1).max(100_000_000),
  countStrategy: z.enum(capacityCountStrategies),
  runtimeRevision: z.string().trim().max(500),
  tokenizer: z.string().trim().max(500),
  template: z.string().trim().max(500),
});

export type CapacityFormValue = z.infer<typeof capacityFormSchema>;

export const newCapacityDefaults: CapacityFormValue = {
  label: "",
  runtimeModel: "",
  runtimeIdentityKey: "",
  hardConcurrencyLimit: 1,
  physicalMaxContext: 32_768,
  countStrategy: "CONSERVATIVE_ESTIMATE",
  runtimeRevision: "",
  tokenizer: "",
  template: "",
};

export function capacityMutationPayload(value: CapacityFormValue) {
  return {
    label: value.label.trim(),
    runtimeModel: value.runtimeModel.trim(),
    runtimeIdentityKey: value.runtimeIdentityKey.trim(),
    hardConcurrencyLimit: value.hardConcurrencyLimit,
    physicalMaxContext: value.physicalMaxContext,
    countStrategy: value.countStrategy,
    runtimeRevision: value.runtimeRevision.trim() || null,
    tokenizer: value.tokenizer.trim() || null,
    tokenizerVersion: null,
    template: value.template.trim() || null,
    templateVersion: null,
    engine: null,
    cacheNamespace: null,
  };
}

export function directPolicyIsValid(input: {
  priority: string;
  concurrency: string;
  reserved: string;
  wait: string;
  ceiling: string;
  margin: string;
  hardLimit: number | null;
}) {
  const values = [
    input.priority,
    input.concurrency,
    input.reserved,
    input.wait,
    input.ceiling,
    input.margin,
  ];
  if (values.some((value) => value.trim() === "")) return false;
  const [priority, concurrency, reserved, wait, ceiling, margin] = values.map(Number);
  return (
    [priority, concurrency, reserved, wait, ceiling, margin].every(Number.isInteger) &&
    priority >= 0 &&
    priority <= 31 &&
    concurrency > 0 &&
    reserved >= 0 &&
    wait >= 0 &&
    ceiling > 0 &&
    margin >= 0 &&
    (input.hardLimit === null || reserved <= input.hardLimit)
  );
}

export const capacityUiInvariants = {
  touchClass: "min-h-11",
  responsiveGridClass: "sm:grid-cols-2",
  boundedHorizontalClass: "overflow-x-clip",
  advancedElement: "details",
} as const;

export function capacityListViewState(input: {
  pending: boolean;
  error: boolean;
  count: number;
}): "loading" | "error" | "empty" | "content" {
  if (input.pending) return "loading";
  if (input.error) return "error";
  return input.count === 0 ? "empty" : "content";
}

export const advancedDisclosureProps = {
  containerElement: "details",
  triggerElement: "summary",
  triggerClassName: "min-h-11 cursor-pointer py-2 text-sm font-medium",
} as const;

export function directPolicyPayload(input: {
  executionTargetId: string;
  capacityId: string;
  priority: string;
  concurrency: string;
  reserved: string;
  wait: string;
  ceiling: string;
  margin: string;
  borrow: "NEVER" | "WHEN_IDLE";
}) {
  return {
    executionTargetId: input.executionTargetId,
    inferenceCapacityId: input.capacityId || null,
    directPriority: Number(input.priority),
    directConcurrencyLimit: Number(input.concurrency),
    directReservedSlots: Number(input.reserved),
    directWaitBudgetMs: Number(input.wait),
    directContextCeiling: Number(input.ceiling),
    directContextMargin: Number(input.margin),
    directBorrowPolicy: input.borrow,
  };
}

export function memberPolicyPayload(input: {
  poolMemberId: string;
  priority: string;
  reserved: string;
  wait: string;
  ceiling: string;
}) {
  return {
    poolMemberId: input.poolMemberId,
    capacityPriority: Number(input.priority),
    capacityReservedSlots: Number(input.reserved),
    capacityWaitBudgetMs: Number(input.wait),
    capacityContextCeiling: Number(input.ceiling),
  };
}

export function createMemberFollowUps(input: {
  memberId: string;
  executionTargetId: string;
  capacityId: string;
  priority: string;
  reserved: string;
  wait: string;
  ceiling: string;
}) {
  return [
    {
      kind: "member-policy" as const,
      input: memberPolicyPayload({ poolMemberId: input.memberId, ...input }),
    },
    {
      kind: "capacity-attachment" as const,
      input: {
        executionTargetId: input.executionTargetId,
        inferenceCapacityId: input.capacityId || null,
      },
    },
  ] as const;
}

export function followUpRecoveryState(completed: number, total: number) {
  return completed === total ? "complete" : completed === 0 ? "member-created" : "policy-saved";
}
