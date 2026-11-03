/**
 * Instance steps that wait for a person, and the instance's denormalized `needsOperator` STEP
 * that follows them (spec §3.6). One definition for every reader and writer:
 *
 * - A step "needs a person" ({@link stepNeedsPerson}, {@link stepNeedsPersonWhere}) when it is
 *   an interactive step AWAITING_OPERATOR (terminal open or closed), a HELD step (PENDING with an
 *   `operatorHold`: an interactive step that may not open its terminal yet, see
 *   {@link isHeldStep}), or a person's accepted run past its timeout (of any run: it still runs
 *   and the instance's stops wait behind it).
 * - The instance's need is STEP exactly while one of its current run's steps needs a person
 *   ({@link syncNeedsOperator}); MARK_STOPPED and RESTART are decided by the stop and restart
 *   rules, never by a step.
 * - A step leaves PENDING (or a live dispatch) for good through {@link endSteps}, which always
 *   clears its hold (CHECK: a hold only on PENDING) and then brings the need up to date.
 */
import type { Prisma } from "@ws-model-proxy/db";
import type { OperatorNeed } from "./instance-phase";
import { resolveRun } from "./instance-run";

type Tx = Prisma.TransactionClient;

/** The one hidden sub-state of PENDING: an interactive step held before its claim. */
export function isHeldStep(step: { state: string; operatorHold: string | null }): boolean {
  return step.state === "PENDING" && step.operatorHold !== null;
}

/** A person's accepted interactive run past its timeout (of any run). */
export function overdueAcceptedRunWhere(now: Date): Prisma.InstanceStepWhereInput {
  return { state: "RUNNING", operatorAcceptedAt: { not: null }, deadline: { lte: now } };
}

/**
 * Steps waiting for a person. With `run`, the screens and holds count only for that run (the
 * instance's need: an earlier run's screens never raise it); without, any run's (which step to
 * show a person).
 */
export function stepNeedsPersonWhere(
  now: Date,
  options: { run?: number } = {},
): Prisma.InstanceStepWhereInput {
  const waiting: Prisma.InstanceStepWhereInput = {
    OR: [{ state: "AWAITING_OPERATOR" }, { state: "PENDING", operatorHold: { not: null } }],
  };
  return {
    OR: [
      options.run === undefined ? waiting : { generation: options.run, ...waiting },
      overdueAcceptedRunWhere(now),
    ],
  };
}

export type NeedsPersonStep = {
  state: string;
  operatorHold: string | null;
  operatorAcceptedAt: Date | null;
  deadline: Date | null;
  generation: number;
};

/** The in-memory form of {@link stepNeedsPersonWhere} (the same rows). */
export function stepNeedsPerson(
  step: NeedsPersonStep,
  now: Date,
  options: { run?: number } = {},
): boolean {
  const overdue =
    step.state === "RUNNING" &&
    step.operatorAcceptedAt !== null &&
    step.deadline !== null &&
    step.deadline.getTime() <= now.getTime();
  if (overdue) return true;
  if (options.run !== undefined && step.generation !== options.run) return false;
  return step.state === "AWAITING_OPERATOR" || isHeldStep(step);
}

/** Whether a step of the instance's current run (or an overdue accepted run) needs a person. */
export async function operatorStepWaiting(tx: Tx, instanceId: string, now: Date): Promise<boolean> {
  const run = await resolveRun(tx, instanceId);
  const waiting = await tx.instanceStep.count({
    where: { instanceId, ...stepNeedsPersonWhere(now, { run }) },
  });
  return waiting > 0;
}

/**
 * The need the step rules give an instance whose need is `current`: STEP while a step waits for
 * its person, none once none does; MARK_STOPPED and RESTART are kept (the stop and restart rules
 * own them).
 */
export function stepRuleNeed(current: OperatorNeed | null, waiting: boolean): OperatorNeed | null {
  if (current === "MARK_STOPPED" || current === "RESTART") return current;
  return waiting ? "STEP" : null;
}

/** Writes `need` when it differs from the stored one (`needsOperatorSince` restarts with it). */
export async function writeOperatorNeed(
  tx: Tx,
  instanceId: string,
  need: OperatorNeed | null,
  now: Date,
  current?: OperatorNeed | null,
): Promise<void> {
  const stored =
    current !== undefined
      ? current
      : ((
          await tx.runtimeInstance.findUnique({
            where: { id: instanceId },
            select: { needsOperator: true },
          })
        )?.needsOperator ?? null);
  if (stored === need) return;
  await tx.runtimeInstance.update({
    where: { id: instanceId },
    data: { needsOperator: need, needsOperatorSince: need ? now : null },
  });
}

/** Brings the instance's STEP need up to date with its steps (MARK_STOPPED and RESTART kept). */
export async function syncNeedsOperator(tx: Tx, instanceId: string, now: Date): Promise<void> {
  const instance = await tx.runtimeInstance.findUnique({
    where: { id: instanceId },
    select: { needsOperator: true },
  });
  if (!instance) return;
  // Decided by the stop and restart rules: no step count needed.
  if (instance.needsOperator === "MARK_STOPPED" || instance.needsOperator === "RESTART") return;
  const need = stepRuleNeed(instance.needsOperator, await operatorStepWaiting(tx, instanceId, now));
  await writeOperatorNeed(tx, instanceId, need, now, instance.needsOperator);
}

/** A step's final write: CANCELLED (proof it never ran) or FAILED, with what goes with it. */
export type StepEndData = Omit<
  Prisma.InstanceStepUpdateManyMutationInput,
  "state" | "operatorHold"
> & { state: "CANCELLED" | "FAILED" };

/**
 * Ends the instance's steps that match `where` (PENDING ones, or live dispatches the caller
 * closed): always with the hold cleared, and with the instance's need brought up to date when
 * any changed. `need: "caller"` only where the caller recomputes the whole need itself in the
 * same transaction (the stop rules). Returns how many steps ended.
 */
export async function endSteps(
  tx: Tx,
  input: {
    instanceId: string;
    where: Prisma.InstanceStepWhereInput;
    data: StepEndData;
    now: Date;
    need?: "sync" | "caller";
  },
): Promise<number> {
  const changed = await tx.instanceStep.updateMany({
    where: { ...input.where, instanceId: input.instanceId },
    data: { ...input.data, operatorHold: null },
  });
  if (changed.count > 0 && input.need !== "caller")
    await syncNeedsOperator(tx, input.instanceId, input.now);
  return changed.count;
}

/** A never-sent step is CANCELLED (proof it never ran); one sent before is FAILED `code`. */
export function endedNeverSentOr(attempts: number, code: string): StepEndData {
  return attempts === 0 ? { state: "CANCELLED" } : { state: "FAILED", errorCode: code };
}
