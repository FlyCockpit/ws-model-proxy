/**
 * THE request compatibility policy: one pure function applied to every JSON request body a
 * runtime receives, whether forwarded natively or rendered by the protocol adapter. It applies,
 * in order: the runtime's rewrite rules, the fixes learned from the engine's 400s, and the
 * unknown-field policy against the engine's accepted profile. Semantic fields are never dropped
 * unless the operator allowed it. The report carries field paths and counts, never values.
 */
import {
  type AcceptedNode,
  type CompatEndpoint,
  type FieldPathSegment,
  formatFieldPath,
  isSemanticPath,
  type LearnedFix,
  parseFieldPath,
  type RequestCompat,
  type RewriteRule,
  SEMANTIC_EQUIVALENTS,
} from "@ws-model-proxy/api/lib/request-compat";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CompatReport = {
  /** Field paths removed (deduplicated). */
  dropped: string[];
  /** Applied rewrites, e.g. `rename:max_completion_tokens>max_tokens`, `mapRole:developer>system`. */
  rewrites: string[];
};

export type CompatRefusal = {
  /** `unknown_field` (strict policy) or `semantic_field` (an engine rejected a semantic field). */
  code: "unknown_field" | "semantic_field";
  path: string;
  message: string;
};

export type CompatInput = {
  endpoint: CompatEndpoint;
  body: Json;
  compat: RequestCompat;
  /** What the engine accepts at this endpoint (its description); null when unknown. */
  accepted: AcceptedNode | null;
  learned: readonly LearnedFix[];
};

export type CompatResult =
  | { ok: true; body: Json; report: CompatReport }
  | { ok: false; refusal: CompatRefusal };

/** Calls `visit(parent, key)` for every object holding the last key of `segments`. */
function forEachHolder(
  value: unknown,
  segments: readonly FieldPathSegment[],
  visit: (holder: Json, key: string) => void,
): void {
  const [head, ...rest] = segments;
  if (!head || !isObject(value)) return;
  if (rest.length === 0 && !head.each) {
    visit(value, head.key);
    return;
  }
  // Own keys only: a path never walks into a prototype.
  if (!Object.hasOwn(value, head.key)) return;
  const child = value[head.key];
  if (head.each) {
    if (!Array.isArray(child) || rest.length === 0) return;
    for (const item of child) forEachHolder(item, rest, visit);
    return;
  }
  forEachHolder(child, rest, visit);
}

function ruleApplies(rule: { endpoint?: CompatEndpoint }, endpoint: CompatEndpoint): boolean {
  return rule.endpoint === undefined || rule.endpoint === endpoint;
}

function roleHolders(body: Json): Json[] {
  const holders: Json[] = [];
  for (const key of ["messages", "input"]) {
    const list = body[key];
    if (Array.isArray(list)) for (const entry of list) if (isObject(entry)) holders.push(entry);
  }
  return holders;
}

function mapRole(body: Json, from: string, to: string): number {
  let count = 0;
  for (const entry of roleHolders(body))
    if (entry.role === from) {
      entry.role = to;
      count += 1;
    }
  return count;
}

function renameAt(body: Json, path: string, to: string): number {
  const segments = parseFieldPath(path);
  if (!segments) return 0;
  let count = 0;
  forEachHolder(body, segments, (holder, key) => {
    if (!Object.hasOwn(holder, key) || Object.hasOwn(holder, to)) return;
    holder[to] = holder[key];
    delete holder[key];
    count += 1;
  });
  return count;
}

function dropAt(body: Json, path: string): number {
  const segments = parseFieldPath(path);
  if (!segments) return 0;
  let count = 0;
  forEachHolder(body, segments, (holder, key) => {
    if (!Object.hasOwn(holder, key)) return;
    delete holder[key];
    count += 1;
  });
  return count;
}

function applyRule(body: Json, rule: RewriteRule, report: CompatReport): void {
  switch (rule.op) {
    case "rename":
      if (renameAt(body, rule.path, rule.to) > 0)
        report.rewrites.push(`rename:${rule.path}>${rule.to}`);
      return;
    case "drop":
      if (dropAt(body, rule.path) > 0) report.dropped.push(rule.path);
      return;
    case "default": {
      const segments = parseFieldPath(rule.path);
      if (!segments) return;
      // Creates missing parent objects; never replaces a value the caller sent.
      let holder: Json = body;
      for (const segment of segments.slice(0, -1)) {
        const next = Object.hasOwn(holder, segment.key) ? holder[segment.key] : undefined;
        if (next === undefined) holder[segment.key] = {};
        else if (!isObject(next)) return;
        holder = holder[segment.key] as Json;
      }
      const last = segments.at(-1)!.key;
      if (Object.hasOwn(holder, last)) return;
      holder[last] = rule.value;
      report.rewrites.push(`default:${rule.path}`);
      return;
    }
    case "clamp": {
      const segments = parseFieldPath(rule.path);
      if (!segments) return;
      let changed = false;
      forEachHolder(body, segments, (holder, key) => {
        const value = holder[key];
        if (typeof value !== "number") return;
        const clamped = Math.min(rule.max ?? value, Math.max(rule.min ?? value, value));
        if (clamped !== value) {
          holder[key] = clamped;
          changed = true;
        }
      });
      if (changed) report.rewrites.push(`clamp:${rule.path}`);
      return;
    }
    case "mapRole":
      if (mapRole(body, rule.from, rule.to) > 0)
        report.rewrites.push(`mapRole:${rule.from}>${rule.to}`);
      return;
  }
}

function applyLearned(
  body: Json,
  fix: LearnedFix,
  report: CompatReport,
  mayDrop: (path: string) => boolean,
) {
  switch (fix.kind) {
    case "rename":
      if (renameAt(body, fix.path, fix.to) > 0)
        report.rewrites.push(`rename:${fix.path}>${fix.to}`);
      return;
    case "mapRole":
      if (mapRole(body, fix.from, fix.to) > 0)
        report.rewrites.push(`mapRole:${fix.from}>${fix.to}`);
      return;
    case "drop":
      if (mayDrop(fix.path) && dropAt(body, fix.path) > 0) report.dropped.push(fix.path);
      return;
  }
}

/** Every path in `value` the accepted node does not know, at closed objects only. */
export function unknownPaths(
  value: unknown,
  node: AcceptedNode,
  path: FieldPathSegment[] = [],
): string[] {
  const found: string[] = [];
  const visit = (
    current: unknown,
    accepted: AcceptedNode,
    at: FieldPathSegment[],
    depth: number,
  ) => {
    if (depth > 16 || found.length > 64) return;
    if (Array.isArray(current)) {
      if (!accepted.i || at.length === 0) return;
      const parent = at.slice(0, -1);
      const last = at.at(-1)!;
      const itemPath = [...parent, { key: last.key, each: true }];
      for (const item of current) visit(item, accepted.i, itemPath, depth + 1);
      return;
    }
    if (!isObject(current) || !accepted.p) return;
    for (const [key, child] of Object.entries(current)) {
      const childNode = Object.hasOwn(accepted.p, key) ? accepted.p[key] : undefined;
      const childPath = [...at, { key, each: false }];
      if (childNode === undefined) {
        if (!accepted.o) found.push(formatFieldPath(childPath));
        continue;
      }
      visit(child, childNode, childPath, depth + 1);
    }
  };
  visit(value, node, path, 0);
  return [...new Set(found)];
}

/** The message roles the description lists (chat `messages[].role`), or null. */
export function acceptedRoles(accepted: AcceptedNode): string[] | null {
  for (const key of ["messages", "input"]) {
    const role = accepted.p?.[key]?.i?.p?.role;
    if (role?.e) return role.e;
  }
  return null;
}

/**
 * Applies the runtime's compatibility policy to a request body. The input body is not mutated.
 */
export function applyRequestCompat(input: CompatInput): CompatResult {
  const body = structuredClone(input.body);
  const report: CompatReport = { dropped: [], rewrites: [] };
  const policy = input.compat.unknownFieldPolicy ?? "auto";
  const allowed = new Set(input.compat.allowDropSemanticFields ?? []);
  const mayDrop = (path: string) => !isSemanticPath(path) || allowed.has(path);

  for (const rule of input.compat.rewriteRules ?? [])
    if (ruleApplies(rule, input.endpoint)) applyRule(body, rule, report);
  // Learned fixes are the engine's own answers; `forward` sends everything as the caller wrote.
  if (policy !== "forward")
    for (const fix of input.learned) applyLearned(body, fix, report, mayDrop);

  if (input.accepted && policy === "auto") {
    // An engine whose description has no `developer` role but a `system` one gets the
    // instructions as `system` (same meaning) instead of a 400.
    const roles = acceptedRoles(input.accepted);
    if (roles && !roles.includes("developer") && roles.includes("system")) {
      if (mapRole(body, "developer", "system") > 0)
        report.rewrites.push("mapRole:developer>system");
    }
  }
  if (input.accepted && policy !== "forward") {
    for (const path of unknownPaths(body, input.accepted)) {
      if (policy === "strict")
        return {
          ok: false,
          refusal: {
            code: "unknown_field",
            path,
            message: `This model's engine does not accept "${path}" (the runtime refuses unknown fields).`,
          },
        };
      // A semantic field the description does not list still goes to the engine: the
      // description may be incomplete, and the engine's own answer decides.
      if (mayDrop(path) && dropAt(body, path) > 0) report.dropped.push(path);
    }
  }
  report.dropped = [...new Set(report.dropped)];
  return { ok: true, body, report };
}

export type RetryPlan =
  | { action: "learn"; fix: LearnedFix }
  | { action: "stripHeader"; name: string }
  | { action: "refuse"; refusal: CompatRefusal };

/**
 * What to do about an engine rejection of a request built with `compat`: learn a fix and retry
 * once, or refuse with a clear error naming a semantic field. Null: pass the engine's answer on.
 */
export function planCompatRetry(input: {
  endpoint: CompatEndpoint;
  compat: RequestCompat;
  rejection:
    | { kind: "field"; path: string }
    | { kind: "replace"; path: string; with: string }
    | { kind: "role"; value: string }
    | { kind: "header"; name: string };
  excerpt: string;
}): RetryPlan | null {
  const policy = input.compat.unknownFieldPolicy ?? "auto";
  const { rejection } = input;
  if (rejection.kind === "header") {
    const mode =
      input.compat.headers?.[rejection.name as keyof NonNullable<RequestCompat["headers"]>];
    return policy === "auto" && mode !== "forward"
      ? { action: "stripHeader", name: rejection.name }
      : null;
  }
  if (rejection.kind === "role") {
    // developer → system keeps the meaning (both are instructions); other roles do not map.
    if (policy === "auto" && rejection.value === "developer")
      return { action: "learn", fix: { kind: "mapRole", from: "developer", to: "system" } };
    return refuse("messages[].role", input.excerpt, `role "${rejection.value}"`);
  }
  const path = rejection.path;
  // Only a plain field path is ever learned (never an object internal or a malformed one).
  if (!parseFieldPath(path)) return null;
  const equivalents = SEMANTIC_EQUIVALENTS[input.endpoint] ?? {};
  const equivalent = Object.hasOwn(equivalents, path) ? (equivalents[path] ?? null) : null;
  const replacement =
    rejection.kind === "replace" ? (equivalent === rejection.with ? equivalent : null) : equivalent;
  if (policy === "auto" && replacement)
    return { action: "learn", fix: { kind: "rename", path, to: replacement } };
  const allowed = new Set(input.compat.allowDropSemanticFields ?? []);
  if (isSemanticPath(path) && !allowed.has(path)) return refuse(path, input.excerpt, `"${path}"`);
  if (policy !== "auto") return null;
  return { action: "learn", fix: { kind: "drop", path } };
}

function refuse(path: string, excerpt: string, what: string): RetryPlan {
  return {
    action: "refuse",
    refusal: {
      code: "semantic_field",
      path,
      message: `This model's engine rejected ${what}. It was not removed because that would change the result; remove it, or ask the runtime's owner to allow dropping it. Engine said: ${excerpt}`,
    },
  };
}
