import { z } from "zod";

export const capacityCountStrategies = [
  "CONSERVATIVE_ESTIMATE",
  "ENGINE_REPORTED",
  "TOKENIZER",
  "TEMPLATE_AWARE",
] as const;

export const finiteLimitModes = ["LIMITED", "UNLIMITED"] as const;
export const inheritedLimitModes = ["INHERIT", "LIMITED"] as const;
export type FiniteLimitMode = (typeof finiteLimitModes)[number];
export type InheritedLimitMode = (typeof inheritedLimitModes)[number];
export type MemberLimitMode = "INHERIT" | FiniteLimitMode;

export const capacityFormSchema = z.object({
  label: z.string().trim().min(1).max(120),
  runtimeModel: z.string().trim().min(1).max(500),
  runtimeIdentityKey: z.string().trim().min(1).max(500),
  hardConcurrencyMode: z.enum(finiteLimitModes),
  hardConcurrencyLimit: z.number().int().min(1).max(10_000),
  physicalMaxContextMode: z.enum(finiteLimitModes),
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
  hardConcurrencyMode: "LIMITED",
  hardConcurrencyLimit: 1,
  physicalMaxContextMode: "LIMITED",
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
    hardConcurrencyLimit:
      value.hardConcurrencyMode === "LIMITED" ? value.hardConcurrencyLimit : null,
    physicalMaxContext:
      value.physicalMaxContextMode === "LIMITED" ? value.physicalMaxContext : null,
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
  concurrencyMode?: FiniteLimitMode;
  waitMode?: FiniteLimitMode;
  ceilingMode?: FiniteLimitMode;
}) {
  const concurrencyMode = input.concurrencyMode ?? "LIMITED";
  const waitMode = input.waitMode ?? "LIMITED";
  const ceilingMode = input.ceilingMode ?? "LIMITED";
  const values = [input.priority, input.reserved, input.margin];
  if (concurrencyMode === "LIMITED") values.push(input.concurrency);
  if (waitMode === "LIMITED") values.push(input.wait);
  if (ceilingMode === "LIMITED") values.push(input.ceiling);
  if (values.some((value) => value.trim() === "")) return false;
  const priority = Number(input.priority);
  const concurrency = Number(input.concurrency);
  const reserved = Number(input.reserved);
  const wait = Number(input.wait);
  const ceiling = Number(input.ceiling);
  const margin = Number(input.margin);
  return (
    [priority, reserved, margin].every(Number.isInteger) &&
    (concurrencyMode === "UNLIMITED" || Number.isInteger(concurrency)) &&
    (waitMode === "UNLIMITED" || Number.isInteger(wait)) &&
    (ceilingMode === "UNLIMITED" || Number.isInteger(ceiling)) &&
    priority >= 0 &&
    priority <= 31 &&
    (concurrencyMode === "UNLIMITED" || concurrency > 0) &&
    reserved >= 0 &&
    (waitMode === "UNLIMITED" || wait >= 0) &&
    (ceilingMode === "UNLIMITED" || ceiling > 0) &&
    margin >= 0 &&
    (input.hardLimit === null ||
      concurrencyMode === "UNLIMITED" ||
      concurrency <= input.hardLimit) &&
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
  concurrencyMode?: FiniteLimitMode;
  waitMode?: FiniteLimitMode;
  ceilingMode?: FiniteLimitMode;
}) {
  return {
    executionTargetId: input.executionTargetId,
    inferenceCapacityId: input.capacityId || null,
    directPriority: Number(input.priority),
    directConcurrencyLimit:
      (input.concurrencyMode ?? "LIMITED") === "LIMITED" ? Number(input.concurrency) : null,
    directReservedSlots: Number(input.reserved),
    directWaitBudgetMs: (input.waitMode ?? "LIMITED") === "LIMITED" ? Number(input.wait) : null,
    directContextCeiling:
      (input.ceilingMode ?? "LIMITED") === "LIMITED" ? Number(input.ceiling) : null,
    directContextMargin: Number(input.margin),
    directBorrowPolicy: input.borrow,
  };
}

export function memberPolicyPayload(input: {
  poolMemberId: string;
  priority: string;
  concurrency?: string;
  reserved: string;
  wait: string;
  ceiling: string;
  margin?: string;
  borrow?: "NEVER" | "WHEN_IDLE";
  concurrencyMode?: MemberLimitMode;
  priorityMode?: "INHERIT" | "OVERRIDE";
  reservedMode?: "INHERIT" | "OVERRIDE";
  waitMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  ceilingMode?: "INHERIT" | "LIMITED" | "UNLIMITED";
  borrowMode?: "INHERIT" | "OVERRIDE";
  marginMode?: InheritedLimitMode;
}) {
  return {
    poolMemberId: input.poolMemberId,
    capacityPriority:
      (input.priorityMode ?? "OVERRIDE") === "OVERRIDE" ? Number(input.priority) : null,
    capacityConcurrencyMode: input.concurrencyMode ?? "INHERIT",
    capacityConcurrencyLimit:
      input.concurrencyMode === "LIMITED" ? Number(input.concurrency) : null,
    capacityReservedSlots:
      (input.reservedMode ?? "OVERRIDE") === "OVERRIDE" ? Number(input.reserved) : null,
    capacityWaitBudgetMode: input.waitMode ?? "INHERIT",
    capacityWaitBudgetMs: input.waitMode === "LIMITED" ? Number(input.wait) : null,
    capacityContextCeilingMode: input.ceilingMode ?? "INHERIT",
    capacityContextCeiling: input.ceilingMode === "LIMITED" ? Number(input.ceiling) : null,
    capacityBorrowPolicy: (input.borrowMode ?? "INHERIT") === "OVERRIDE" ? input.borrow : null,
    capacityContextMargin:
      (input.marginMode ?? "INHERIT") === "LIMITED" ? Number(input.margin) : null,
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
      input: memberPolicyPayload({
        poolMemberId: input.memberId,
        ...input,
        waitMode: "LIMITED",
        ceilingMode: "LIMITED",
      }),
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
