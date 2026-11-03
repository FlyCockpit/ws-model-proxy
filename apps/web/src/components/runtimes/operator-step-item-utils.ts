import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
export type OperatorStepView = RuntimeDetail["instanceList"][number]["openSteps"][number];

/** Why a step waits before its terminal opens (`InstanceStep.operatorHold`, as errorCode). */
const HOLDS: ReadonlySet<string> = new Set([
  "operator_capability_missing",
  "operator_session_full",
  "operator_node_full",
  "operator_terminals_disabled",
]);

/** What the step waits for, as one translation key. */
export function operatorStepStatusKey(step: OperatorStepView): string {
  if (step.state === "PENDING")
    return step.errorCode && HOLDS.has(step.errorCode)
      ? `terminals:steps.hold.${step.errorCode}`
      : "terminals:steps.queued";
  if (step.state === "RUNNING")
    return step.terminalOpen ? "terminals:steps.running" : "terminals:steps.queued";
  if (step.state === "AWAITING_OPERATOR")
    return step.terminalOpen
      ? "terminals:steps.waiting"
      : step.errorCode && HOLDS.has(step.errorCode)
        ? `terminals:steps.hold.${step.errorCode}`
        : "terminals:steps.closed";
  return "terminals:steps.done";
}
