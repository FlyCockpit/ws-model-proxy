import { describe, expect, it } from "vitest";
import {
  type PlacementContext,
  type PlacementInstance,
  type PlacementNode,
  PlacementPlanner,
  type PlacementRequest,
} from "./placement";

// A differential check of GPU placement on one node against an independent brute-force model:
// for many generated nodes (unified and dedicated GPUs of one or two vendors) with claims on them,
// some over-committed since (the node's memory or a GPU shrank), a new claim (a start, or a
// restart of a claim already there) is placed exactly when some set of GPUs fits it, and what is
// placed fits.
//
// The model: node memory holds every claim's RAM plus the VRAM of each unified GPU it uses; a
// dedicated GPU holds the VRAM of each claim on it. A restart's old and new claims overlap: on
// every resource the instance takes the larger of the two. A claim fits when, with it placed, the
// resources it is on are within their size: node memory (every claim is on it) and each GPU it
// uses. Another claim's over-commit of a GPU it does not use is not its concern.

type Vendor = "nvidia" | "amd";
type Gpu = { key: string; vendor: Vendor; vramGb: number; unified: boolean };
type Claim = { ramGb: number; vramGb: number; keys: string[] };
type Needs = { ramGb: number; gpuCount: number; vramGb: number; vendor: Vendor | null };
type Case = { memoryGb: number; gpus: Gpu[]; claims: Claim[]; needs: Needs; restart: boolean };

/** Deterministic: the same seed generates the same cases. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}

/** What each resource holds: node memory, and each dedicated GPU's VRAM. */
type Usage = { memoryGb: number; gpus: Map<string, number> };

function usageOf(gpus: readonly Gpu[], claim: Claim): Usage {
  const usage: Usage = { memoryGb: claim.ramGb, gpus: new Map() };
  for (const key of claim.keys) {
    const gpu = gpus.find((candidate) => candidate.key === key);
    if (!gpu) continue;
    if (gpu.unified) usage.memoryGb += claim.vramGb;
    else usage.gpus.set(key, (usage.gpus.get(key) ?? 0) + claim.vramGb);
  }
  return usage;
}

function sum(usages: readonly Usage[]): Usage {
  const total: Usage = { memoryGb: 0, gpus: new Map() };
  for (const usage of usages) {
    total.memoryGb += usage.memoryGb;
    for (const [key, gb] of usage.gpus) total.gpus.set(key, (total.gpus.get(key) ?? 0) + gb);
  }
  return total;
}

/** On every resource the larger of the two (a restart's old and new claims). */
function overlap(a: Usage, b: Usage): Usage {
  const gpus = new Map(a.gpus);
  for (const [key, gb] of b.gpus) gpus.set(key, Math.max(gpus.get(key) ?? 0, gb));
  return { memoryGb: Math.max(a.memoryGb, b.memoryGb), gpus };
}

function fits(memoryGb: number, gpus: readonly Gpu[], usage: Usage): boolean {
  if (usage.memoryGb > memoryGb + 1e-9) return false;
  for (const [key, gb] of usage.gpus) {
    const gpu = gpus.find((candidate) => candidate.key === key);
    if (!gpu || gb > gpu.vramGb + 1e-9) return false;
  }
  return true;
}

/**
 * What the node holds with `added` (the new claim) placed: the other claims, plus for a restart
 * the overlap of the restarted claim (the first one) and the new one.
 */
function withClaim(c: Case, added: Claim): Usage {
  const others = c.restart ? c.claims.slice(1) : c.claims;
  const placed = usageOf(c.gpus, added);
  const own = c.restart && c.claims[0] ? overlap(usageOf(c.gpus, c.claims[0]), placed) : placed;
  return sum([...others.map((claim) => usageOf(c.gpus, claim)), own]);
}

/** Whether `added` fits (the model's rule, above). */
function placementFits(c: Case, added: Claim): boolean {
  const after = withClaim(c, added);
  if (after.memoryGb > c.memoryGb + 1e-9) return false;
  for (const key of added.keys) {
    const gpu = c.gpus.find((candidate) => candidate.key === key);
    if (!gpu) return false;
    if (!gpu.unified && (after.gpus.get(key) ?? 0) > gpu.vramGb + 1e-9) return false;
  }
  return true;
}

function* subsets<T>(items: readonly T[], count: number, from = 0): Generator<T[]> {
  if (count === 0) {
    yield [];
    return;
  }
  for (let index = from; index <= items.length - count; index++)
    for (const rest of subsets(items, count - 1, index + 1)) yield [items[index] as T, ...rest];
}

/** Whether some set of GPUs fits the new claim (one vendor; the one it names, if any). */
function oracleFits(c: Case): boolean {
  const { needs } = c;
  if (needs.gpuCount === 0) return placementFits(c, { ramGb: needs.ramGb, vramGb: 0, keys: [] });
  for (const vendor of ["nvidia", "amd"] as const) {
    if (needs.vendor !== null && needs.vendor !== vendor) continue;
    const own = c.gpus.filter((gpu) => gpu.vendor === vendor);
    for (const set of subsets(own, needs.gpuCount)) {
      const claim = { ramGb: needs.ramGb, vramGb: needs.vramGb, keys: set.map((gpu) => gpu.key) };
      if (placementFits(c, claim)) return true;
    }
  }
  return false;
}

function generate(seed: number): Case | null {
  const r = random(seed);
  const memoryGb = r.pick([32, 48, 64, 96, 128]);
  const vendors: Vendor[] = r.chance(0.5) ? ["nvidia"] : ["nvidia", "amd"];
  const counts = new Map<Vendor, number>();
  const gpus: Gpu[] = Array.from({ length: r.int(1, 4) }, () => {
    const vendor = r.pick(vendors);
    const index = counts.get(vendor) ?? 0;
    counts.set(vendor, index + 1);
    const unified = r.chance(0.35);
    return {
      key: `${vendor}:${index}`,
      vendor,
      unified,
      vramGb: unified ? 0 : r.pick([8, 16, 24, 48]),
    };
  });
  const claims: Claim[] = [];
  for (let attempt = 0; attempt < r.int(0, 4); attempt++) {
    const vendor = r.pick(vendors);
    const own = gpus.filter((gpu) => gpu.vendor === vendor);
    const count = Math.min(own.length, r.int(0, 2));
    const keys: string[] = [];
    const pool = [...own];
    for (let i = 0; i < count; i++)
      keys.push(pool.splice(r.int(0, pool.length - 1), 1)[0]?.key ?? "");
    const claim = {
      ramGb: r.pick([0, 2, 4, 8, 16]),
      vramGb: count ? r.pick([2, 4, 8, 12, 16]) : 0,
      keys,
    };
    // Only claims that fit together: a node nothing over-committed.
    if (fits(memoryGb, gpus, sum([...claims, claim].map((one) => usageOf(gpus, one)))))
      claims.push(claim);
  }
  // Sometimes the node shrank since: its memory, or a dedicated GPU, below what its claims hold.
  let shrunkMemory = memoryGb;
  if (claims.length > 0 && r.chance(0.3)) {
    const used = sum(claims.map((claim) => usageOf(gpus, claim)));
    const shrinkable = gpus.filter((gpu) => !gpu.unified && (used.gpus.get(gpu.key) ?? 0) > 0);
    if (shrinkable.length > 0 && r.chance(0.6)) {
      const gpu = r.pick(shrinkable);
      gpu.vramGb = Math.max(0, (used.gpus.get(gpu.key) ?? 0) - r.pick([2, 4, 8]));
    } else shrunkMemory = Math.max(0, used.memoryGb - r.pick([2, 4, 8]));
  }
  const restart = claims.length > 0 && r.chance(0.4);
  const gpuCount = r.int(0, Math.min(3, gpus.length));
  const needs: Needs = {
    ramGb: r.pick([0, 2, 4, 8, 16, 24]),
    gpuCount,
    vramGb: gpuCount ? r.pick([2, 4, 6, 8, 12, 16, 20]) : 0,
    vendor: gpuCount && r.chance(0.4) ? r.pick(vendors) : null,
  };
  if (gpuCount === 0 && needs.ramGb === 0) return null;
  return { memoryGb: shrunkMemory, gpus, claims, needs, restart };
}

function resourcesOf(claim: Claim, gpus: readonly Gpu[]) {
  if (claim.keys.length === 0) return { kind: "cpu", ramGb: claim.ramGb };
  return {
    kind: "discrete",
    gpuCount: claim.keys.length,
    vramGb: claim.vramGb,
    ...(claim.ramGb ? { ramGb: claim.ramGb } : {}),
    gpus: claim.keys,
    unifiedGpus: claim.keys.filter((key) => gpus.find((gpu) => gpu.key === key)?.unified),
  };
}

/**
 * The case with some claims made legacy (they recorded no GPUs, `legacy`), for the checks below.
 * Only starts: a restart of a guessed claim has no exact model.
 */
function withLegacy(c: Case, seed: number): { c: Case; legacy: boolean[] } | null {
  if (c.restart || c.claims.length === 0) return null;
  const r = random(seed ^ 0x5bd1e995);
  const legacy = c.claims.map((claim) => claim.keys.length > 0 && r.chance(0.5));
  return legacy.some(Boolean) ? { c, legacy } : null;
}

/** Every placement of the legacy claims on their vendor's GPUs (the others as recorded). */
function* assignments(c: Case, legacy: readonly boolean[], from = 0): Generator<Claim[]> {
  if (from === c.claims.length) {
    yield [...c.claims];
    return;
  }
  const claim = c.claims[from] as Claim;
  if (!legacy[from]) {
    yield* assignments(c, legacy, from + 1);
    return;
  }
  const vendor = c.gpus.find((gpu) => gpu.key === claim.keys[0])?.vendor;
  const own = c.gpus.filter((gpu) => gpu.vendor === vendor);
  for (const set of subsets(own, claim.keys.length))
    for (const rest of assignments(c, legacy, from + 1)) {
      rest[from] = { ...claim, keys: set.map((gpu) => gpu.key) };
      yield rest;
    }
}

/**
 * The planner's answer. `admittedAs`: the GPUs as they were when the claims were admitted (which
 * were unified then, recorded as `unifiedGpus`), when the node's report changed since.
 */
function plannerOf(c: Case, legacy: readonly boolean[] = [], admittedAs: readonly Gpu[] = c.gpus) {
  const node: PlacementNode = {
    id: "n",
    slug: "node",
    online: true,
    trust: "FULL",
    held: false,
    labels: [],
    portRange: [30000, 30099],
    heldVersionIds: new Set(),
    requiredVersionIds: new Set(),
    frozenFabrics: null,
    memoryGb: c.memoryGb,
    gpus: c.gpus.map((gpu) => ({ ...gpu })),
    liveFreeMemoryGb: null,
    launch: null,
  };
  const instances: PlacementInstance[] = c.claims.map((claim, index) => ({
    id: index === 0 && c.restart ? "target" : `c${index}`,
    runtimeId: index === 0 && c.restart ? "target" : `rt${index}`,
    ownerId: "u",
    startable: true,
    running: true,
    contributed: false,
    interactiveStop: false,
    ranks: [
      {
        nodeId: "n",
        port: 30000 + index,
        distPort: null,
        claim: "HELD",
        resources: legacy[index]
          ? {
              kind: "discrete",
              gpuCount: claim.keys.length,
              vramGb: claim.vramGb,
              ...(claim.ramGb ? { ramGb: claim.ramGb } : {}),
              vendor: c.gpus.find((gpu) => gpu.key === claim.keys[0])?.vendor,
            }
          : resourcesOf(claim, admittedAs),
      },
    ],
  }));
  const context: PlacementContext = {
    callerId: "u",
    agent: false,
    nodes: [node],
    fabrics: [],
    instances,
  };
  const { needs } = c;
  const resources =
    needs.gpuCount === 0
      ? { kind: "cpu", ramGb: needs.ramGb }
      : {
          kind: "discrete",
          gpuCount: needs.gpuCount,
          vramGb: needs.vramGb,
          ...(needs.ramGb ? { ramGb: needs.ramGb } : {}),
          ...(needs.vendor ? { vendor: needs.vendor } : {}),
        };
  const request = {
    runtimeId: c.restart ? "target" : "new",
    versionId: "v-new",
    launch: { groupSize: 1, labels: [], resources: [resources] },
    nodeIds: ["n"],
    checkFrozen: false,
    preempt: false,
    ...(c.restart ? { restart: { instanceId: "target", ports: [30000], distPort: null } } : {}),
  } as unknown as PlacementRequest;
  return new PlacementPlanner(context).place(request);
}

describe("GPU placement against a brute-force model", () => {
  it("places a claim exactly when some set of GPUs fits it, and what it places fits", () => {
    const disagreements: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 20_000 && disagreements.length < 5; seed++) {
      const c = generate(seed);
      if (!c) continue;
      checked++;
      const expected = oracleFits(c);
      const result = plannerOf(c);
      if (result.ok !== expected) {
        disagreements.push(
          `seed ${seed}: planner ${result.ok ? "placed" : "refused"}, model ${expected ? "fits" : "does not fit"}: ${JSON.stringify(c)}${result.ok ? "" : ` (${result.refusal.reason})`}`,
        );
        continue;
      }
      if (!result.ok) continue;
      const placed = result.start.placements[0];
      const keys = (placed?.resources.gpus as string[] | undefined) ?? [];
      const claim = { ramGb: c.needs.ramGb, vramGb: c.needs.vramGb, keys };
      if (!placementFits(c, claim))
        disagreements.push(
          `seed ${seed}: placed on ${keys.join(",")} but it does not fit: ${JSON.stringify(c)}`,
        );
    }
    expect(disagreements).toEqual([]);
    expect(checked).toBeGreaterThan(10_000);
  });

  it("what it places fits wherever a legacy claim really is", () => {
    // A legacy claim recorded no GPUs: it may be on any set of its vendor's GPUs of its size.
    // Whatever set that is, what is placed must fit (the model's rule).
    const violations: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 20_000 && violations.length < 5; seed++) {
      const base = generate(seed);
      const made = base && withLegacy(base, seed);
      if (!made) continue;
      checked++;
      const { c, legacy } = made;
      const result = plannerOf(c, legacy);
      if (!result.ok) continue;
      const placed = result.start.placements[0];
      const keys = (placed?.resources.gpus as string[] | undefined) ?? [];
      const added = { ramGb: c.needs.ramGb, vramGb: c.needs.vramGb, keys };
      for (const claims of assignments(c, legacy))
        if (!placementFits({ ...c, claims }, added)) {
          violations.push(
            `seed ${seed}: placed on ${keys.join(",")}, over-committed if ${JSON.stringify(claims)}: ${JSON.stringify({ c, legacy })}`,
          );
          break;
        }
    }
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(1_000);
  });

  it("a guess about one vendor's GPUs never changes a placement on another vendor's", () => {
    // NVIDIA claims recorded where they are (some GPU over-committed since), AMD claims that
    // recorded none and take no node memory: a new NVIDIA claim is placed exactly when the model
    // fits it, with or without the AMD guesses.
    const disagreements: string[] = [];
    for (let seed = 1; seed <= 5_000 && disagreements.length < 5; seed++) {
      const r = random(seed);
      const gpus: Gpu[] = [
        ...Array.from({ length: r.int(2, 3) }, (_, index) => ({
          key: `nvidia:${index}`,
          vendor: "nvidia" as const,
          unified: false,
          vramGb: r.pick([8, 16, 24]),
        })),
        ...Array.from({ length: r.int(1, 2) }, (_, index) => ({
          key: `amd:${index}`,
          vendor: "amd" as const,
          unified: false,
          vramGb: r.pick([8, 16, 24]),
        })),
      ];
      const nvidia = gpus.filter((gpu) => gpu.vendor === "nvidia");
      const claims: Claim[] = Array.from({ length: r.int(1, 3) }, () => ({
        ramGb: r.pick([0, 2, 4]),
        vramGb: r.pick([4, 8, 12, 16]),
        keys: [r.pick(nvidia).key],
      }));
      // Some NVIDIA GPU holds more than it has now.
      const used = sum(claims.map((claim) => usageOf(gpus, claim)));
      const target = nvidia.find((gpu) => (used.gpus.get(gpu.key) ?? 0) > 0);
      if (target && r.chance(0.7))
        target.vramGb = Math.max(0, (used.gpus.get(target.key) ?? 0) - r.pick([2, 4, 8]));
      const amd = gpus.filter((gpu) => gpu.vendor === "amd");
      const foreign: Claim[] = Array.from({ length: r.int(1, 2) }, () => ({
        ramGb: 0,
        vramGb: r.pick([4, 8]),
        keys: [r.pick(amd).key],
      }));
      const gpuCount = r.int(1, 2);
      const c: Case = {
        memoryGb: 128,
        gpus,
        claims,
        needs: { ramGb: 0, gpuCount, vramGb: r.pick([4, 8, 12]), vendor: "nvidia" },
        restart: false,
      };
      const expected = oracleFits(c);
      const without = plannerOf(c).ok;
      const withThem = plannerOf({ ...c, claims: [...claims, ...foreign] }, [
        ...claims.map(() => false),
        ...foreign.map(() => true),
      ]).ok;
      if (without !== expected || withThem !== expected)
        disagreements.push(
          `seed ${seed}: model ${expected}, planner ${without} without, ${withThem} with: ${JSON.stringify({ c, foreign })}`,
        );
    }
    expect(disagreements).toEqual([]);
  });

  it("a GPU reported otherwise than when its claims were admitted never lets an over-commit in", () => {
    // Every claim recorded each of its GPUs as the other kind (unified ↔ dedicated) than the
    // node reports now. The process may be on either, so what is placed must still fit as the
    // node is now.
    const violations: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 20_000 && violations.length < 5; seed++) {
      const c = generate(seed);
      if (!c || c.claims.every((claim) => claim.keys.length === 0)) continue;
      checked++;
      const flipped = c.gpus.map((gpu) => ({ ...gpu, unified: !gpu.unified }));
      const result = plannerOf(c, [], flipped);
      if (!result.ok) continue;
      const placed = result.start.placements[0];
      const keys = (placed?.resources.gpus as string[] | undefined) ?? [];
      if (!placementFits(c, { ramGb: c.needs.ramGb, vramGb: c.needs.vramGb, keys }))
        violations.push(`seed ${seed}: placed on ${keys.join(",")}: ${JSON.stringify(c)}`);
    }
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(5_000);
  });

  it("GPUs renumbered and reclassified since their claims were admitted never let an over-commit in", () => {
    // Some GPUs now report under new keys (their old keys gone) and some changed kind. The
    // claims keep their records (old keys, old kinds); what is placed must fit the node as it
    // really is now (each claim on its GPUs under their new keys and kinds).
    const violations: string[] = [];
    let checked = 0;
    for (let seed = 1; seed <= 20_000 && violations.length < 5; seed++) {
      const c = generate(seed);
      if (!c || c.restart || c.claims.every((claim) => claim.keys.length === 0)) continue;
      const r = random(seed ^ 0x9e3779b9);
      const renamed = new Map<string, string>();
      const now: Gpu[] = c.gpus.map((gpu, index) => {
        const key = r.chance(0.5) ? `${gpu.vendor}:${10 + index}` : gpu.key;
        renamed.set(gpu.key, key);
        const unified = r.chance(0.3) ? !gpu.unified : gpu.unified;
        const vramGb = unified ? 0 : gpu.unified ? r.pick([8, 16, 24, 48]) : gpu.vramGb;
        return { ...gpu, key, unified, vramGb };
      });
      if (
        now.every(
          (gpu, index) => gpu.key === c.gpus[index]?.key && gpu.unified === c.gpus[index]?.unified,
        )
      )
        continue;
      checked++;
      const real: Case = {
        ...c,
        gpus: now,
        claims: c.claims.map((claim) => ({
          ...claim,
          keys: claim.keys.map((key) => renamed.get(key) ?? key),
        })),
      };
      const result = plannerOf({ ...c, gpus: now }, [], c.gpus);
      if (!result.ok) continue;
      const placed = result.start.placements[0];
      const keys = (placed?.resources.gpus as string[] | undefined) ?? [];
      if (!placementFits(real, { ramGb: c.needs.ramGb, vramGb: c.needs.vramGb, keys }))
        violations.push(
          `seed ${seed}: placed on ${keys.join(",")}: ${JSON.stringify({ was: c.gpus, real })}`,
        );
    }
    expect(violations).toEqual([]);
    expect(checked).toBeGreaterThan(3_000);
  });
});
