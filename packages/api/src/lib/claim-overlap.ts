/**
 * How one instance's claims on one node add up while a restart's old and new claims both hold
 * (a rank's `prev*` claim, a reservation row a restart superseded): they OVERLAP instead of
 * adding, because the old run's process and the new one never run at the same time (the new
 * run starts only after its leading STOP proved the old one stopped), yet what the old one may
 * still use stays held until then.
 *
 * For one instance on one node, with `current` its current claims and `previous` the replaced
 * run's: memory = max(Σcurrent, Σprevious); GPUs = the union of their keys, each key's VRAM the
 * larger of the two sides; ports = the union (ports are not counted here: every claim's ports
 * stay taken). Different instances (and different nodes) always add.
 *
 * Pure. The placement planner (`placement.ts`) and the node views (`nodes/hardware.ts`) both
 * account claims through it, so what a node shows as reserved is what the planner counts.
 */

/** What claims take on one node: memory (GiB; VRAM of a unified GPU included) and VRAM per GPU. */
export type ClaimUsage = {
  memoryGb: number;
  /** GiB of VRAM per dedicated GPU key (`vendor:index`). */
  gpus: ReadonlyMap<string, number>;
};

export const NO_USAGE: ClaimUsage = { memoryGb: 0, gpus: new Map() };

/** Everything these claims take together (they all run at once). */
export function sumUsage(usages: readonly ClaimUsage[]): ClaimUsage {
  let memoryGb = 0;
  const gpus = new Map<string, number>();
  for (const usage of usages) {
    memoryGb += usage.memoryGb;
    for (const [key, gb] of usage.gpus) gpus.set(key, (gpus.get(key) ?? 0) + gb);
  }
  return { memoryGb, gpus };
}

/** The larger of two usages, component by component (the union of their GPUs). */
export function maxUsage(a: ClaimUsage, b: ClaimUsage): ClaimUsage {
  const gpus = new Map(a.gpus);
  for (const [key, gb] of b.gpus) gpus.set(key, Math.max(gpus.get(key) ?? 0, gb));
  return { memoryGb: Math.max(a.memoryGb, b.memoryGb), gpus };
}

/** `a - b`, component by component (`b`'s GPUs absent from `a` count as 0 there). */
export function subtractUsage(a: ClaimUsage, b: ClaimUsage): ClaimUsage {
  const gpus = new Map(a.gpus);
  for (const [key, gb] of b.gpus) gpus.set(key, (gpus.get(key) ?? 0) - gb);
  return { memoryGb: a.memoryGb - b.memoryGb, gpus };
}

/**
 * What one instance's claims on one node take: the current claims and the replaced run's
 * overlap (`max(Σcurrent, Σprevious)` per component).
 */
export function overlapUsage(
  current: readonly ClaimUsage[],
  previous: readonly ClaimUsage[],
): ClaimUsage {
  if (previous.length === 0) return sumUsage(current);
  return maxUsage(sumUsage(current), sumUsage(previous));
}

/**
 * What adding `added` to an instance's new claims on a node takes beyond what the node already
 * counts for that instance: `floor` is the old claims' usage (still held until their stop is
 * proven), `placed` the new claims placed there so far. The instance then holds
 * max(placed + added, floor), so this is max(placed + added, floor) − max(placed, floor) per
 * component (never negative): a restart costs its growth over the old claims, never old + new.
 */
export function overlapGrowth(
  floor: ClaimUsage,
  placed: ClaimUsage,
  added: ClaimUsage,
): ClaimUsage {
  const before = maxUsage(placed, floor);
  const after = maxUsage(sumUsage([placed, added]), floor);
  return subtractUsage(after, before);
}

/**
 * Memory (GiB) the claims of several instances take on one node, each instance's current and
 * replaced-run claims overlapping (`overlapUsage`), the instances adding.
 */
export function overlapMemoryGb(
  groups: ReadonlyArray<{ current: readonly number[]; previous: readonly number[] }>,
): number {
  const memory = (values: readonly number[]): ClaimUsage => ({
    memoryGb: values.reduce((sum, value) => sum + value, 0),
    gpus: new Map(),
  });
  return groups.reduce(
    (sum, group) => sum + overlapUsage([memory(group.current)], [memory(group.previous)]).memoryGb,
    0,
  );
}
