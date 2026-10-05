import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { ORPCError } from "@orpc/server";
import {
  DEPLOYMENT_COMMAND_MAX_BYTES,
  DEPLOYMENT_PROTOCOL_VERSION,
  deploymentCommandBytes,
} from "@ws-model-proxy/config/deployment-protocol";
import {
  type DeploymentClaim,
  type DeploymentResources,
  type DeploymentVariant,
  rankValue,
} from "./deployment-spec";
import {
  gpuBudgetKey,
  type NodeInfoView,
  type NodeUsableBudgets,
  normalizeNodeLabels,
} from "./node-inventory";

/**
 * A planning refusal is a policy or input outcome, not a server fault: it must
 * reach the dashboard and MCP agents with its status and message instead of
 * an opaque 500.
 */
function refusal(
  code: "BAD_REQUEST" | "CONFLICT" | "FORBIDDEN" | "PRECONDITION_FAILED",
  message: string,
) {
  return new ORPCError(code, { message });
}

/**
 * Rank 0's address on the recipe's interface, as peers reach it. Only a
 * canonical, non-loopback IPv4 literal is accepted: the value is node-reported
 * and is substituted into other ranks' shell commands.
 */
export function deploymentHeadAddress(
  interfaces: ReadonlyArray<{ name: string; addresses?: readonly string[] }> | undefined,
  iface: string | undefined,
): string | undefined {
  return interfaces
    ?.find((i) => i.name === iface)
    ?.addresses?.find((a) => isIPv4(a) && !a.startsWith("127.") && a !== "0.0.0.0");
}

export type DeploymentNode = {
  id: string;
  online: boolean;
  protocolVersion: string | null;
  allowDeployments: boolean;
  reportedDeployments: boolean | null;
  mode: "OFF" | "SUPERVISED" | "UNSUPERVISED";
  localMode: "OFF" | "SUPERVISED" | "UNSUPERVISED" | null;
  execution: string;
  labels: string[];
  info: NodeInfoView;
  budgets: NodeUsableBudgets;
  portStart: number;
  portEnd: number;
};
export type ExistingDeployment = {
  id: string;
  startedBy: "USER" | "AGENT" | "SCHEDULE";
  agentsMayPreempt: boolean;
  nodes: Array<{
    nodeId: string;
    resources: DeploymentClaim;
    port: number;
    distPort: number | null;
    blockedBy: string[];
  }>;
};
export type Placement = {
  nodeId: string;
  rank: number;
  group: number;
  resources: DeploymentClaim;
  port: number;
  distPort: number | null;
};
export type DeploymentPlacementPlan = {
  placements: Placement[];
  stopIds: string[];
  affectedNodeIds: string[];
  effectiveMode: "OFF" | "SUPERVISED" | "UNSUPERVISED";
  requiresConfirmation: boolean;
  headAddr: string;
  warnings: string[];
};

function nodeHasAllLabels(labels: readonly string[], required: readonly string[]) {
  const normalized = new Set(normalizeNodeLabels(labels));
  return required.every((label) => normalized.has(label));
}
function used(claims: DeploymentClaim[]) {
  const gpu = new Map<string, number>();
  for (const c of claims) for (const g of c.gpus) gpu.set(g.key, (gpu.get(g.key) ?? 0) + g.vramGb);
  return {
    memory: claims.reduce((n, c) => n + c.memoryGb, 0),
    ram: claims.reduce((n, c) => n + c.ramGb, 0),
    gpu,
  };
}
function fit(
  node: DeploymentNode,
  req: DeploymentResources,
  claims: DeploymentClaim[],
): DeploymentClaim | null {
  if (node.info.nodeKind !== req.kind) return null;
  const total = used(claims);
  if (req.kind === "unified")
    return req.memoryGb + total.memory <= (node.budgets.usableMemoryGb ?? 0)
      ? { kind: req.kind, memoryGb: req.memoryGb, ramGb: 0, gpus: [] }
      : null;
  if ((req.ramGb ?? 0) + total.ram > (node.budgets.usableRamGb ?? 0)) return null;
  if (req.kind === "cpu") return { kind: req.kind, memoryGb: 0, ramGb: req.ramGb, gpus: [] };
  const available = (node.info.gpus ?? [])
    .map((g) => ({ key: gpuBudgetKey(g), index: g.index }))
    .sort((a, b) => (total.gpu.get(b.key) ?? 0) - (total.gpu.get(a.key) ?? 0) || a.index - b.index)
    .filter(
      (g) => (node.budgets.usableVramGb[g.key] ?? 0) - (total.gpu.get(g.key) ?? 0) >= req.vramGb,
    )
    .slice(0, req.gpuCount);
  return available.length === req.gpuCount
    ? {
        kind: req.kind,
        memoryGb: 0,
        ramGb: req.ramGb ?? 0,
        gpus: available.map((g) => ({ ...g, vramGb: req.vramGb })),
      }
    : null;
}
function conflicts(node: DeploymentNode, req: DeploymentResources, existing: ExistingDeployment[]) {
  const ranks = existing.flatMap((instance) =>
    instance.nodes.filter((n) => n.nodeId === node.id).map((n) => ({ instance, n })),
  );
  if (req.kind !== "discrete") return ranks.map((r) => r.instance.id);
  const total = used(ranks.map((r) => r.n.resources));
  const shortRam = total.ram + (req.ramGb ?? 0) > (node.budgets.usableRamGb ?? 0);
  // First choose a concrete assignment against empty capacity. Stop all claims on
  // those conflicting GPU resources; ranks using exclusively other GPUs survive.
  const empty = fit(node, req, []);
  if (!empty) throw refusal("CONFLICT", `Requirements exceed usable budgets on ${node.id}`);
  const assigned = new Set(empty.gpus.map((g) => g.key));
  return ranks
    .filter(
      (r) =>
        (shortRam && r.n.resources.ramGb > 0) ||
        r.n.resources.gpus.some((g) => assigned.has(g.key)),
    )
    .map((r) => r.instance.id);
}
function gate(node: DeploymentNode) {
  if (!node.online) throw refusal("CONFLICT", `Node ${node.id} is offline`);
  if (node.protocolVersion !== DEPLOYMENT_PROTOCOL_VERSION)
    throw refusal("PRECONDITION_FAILED", `CLI upgrade required on ${node.id}`);
  if (!node.allowDeployments || !node.reportedDeployments)
    throw refusal(
      "PRECONDITION_FAILED",
      `Deployments require local opt-in and server grant on ${node.id}`,
    );
  if (node.execution !== "systemd+linger" && node.execution !== "macos")
    throw refusal(
      "PRECONDITION_FAILED",
      `Unsupported deployment execution on ${node.id}; Linux requires user systemd and linger`,
    );
}
const modeOrder = { OFF: 0, SUPERVISED: 1, UNSUPERVISED: 2 } as const;
/**
 * `nodes` run work, so each must pass the deployment gate. Command modes and confirmation are
 * read from `modeNodes` (default: `nodes`), which for a stop covers every rank of the stopped
 * instances even when a rank holds no claim and runs nothing.
 */
export function deploymentPermission(
  nodes: DeploymentNode[],
  stops: ExistingDeployment[],
  actor: "USER" | "AGENT" | "SCHEDULE",
  offlineStops: ReadonlySet<string> = new Set(),
  modeNodes: DeploymentNode[] = nodes,
) {
  // No node to read a command mode from must never mean "unsupervised".
  if (actor === "AGENT" && modeNodes.length === 0)
    throw refusal("FORBIDDEN", "Deployment commands are off on an affected node");
  for (const node of nodes) gate(offlineStops.has(node.id) ? { ...node, online: true } : node);
  const minimum = Math.min(
    ...modeNodes.flatMap((n) => [modeOrder[n.mode], modeOrder[n.localMode ?? "OFF"]]),
  );
  const effectiveMode = minimum === 0 ? "OFF" : minimum === 1 ? "SUPERVISED" : "UNSUPERVISED";
  if (actor === "AGENT" && effectiveMode === "OFF")
    throw refusal("FORBIDDEN", "Deployment commands are off on an affected node");
  if (
    actor === "AGENT" &&
    effectiveMode === "UNSUPERVISED" &&
    stops.some((s) => s.startedBy !== "AGENT" && !s.agentsMayPreempt)
  )
    throw refusal("FORBIDDEN", "Agent cannot stop a protected human instance");
  return {
    effectiveMode,
    requiresConfirmation: actor === "AGENT" ? effectiveMode === "SUPERVISED" : stops.length > 0,
  } as const;
}
export function planDeployment(input: {
  nodes: DeploymentNode[];
  existing: ExistingDeployment[];
  variant: DeploymentVariant;
  nodeIds?: string[];
  groupCount: number;
  actor: "USER" | "AGENT" | "SCHEDULE";
}): DeploymentPlacementPlan {
  const { nodes, existing, variant } = input;
  const count = variant.groupSize * input.groupCount;
  if (count > 256 || count < 1) throw refusal("BAD_REQUEST", "A plan supports 1–256 ranks");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const candidates = nodes
    .filter((n) => nodeHasAllLabels(n.labels, variant.labels))
    .filter((n) => {
      try {
        gate(n);
        return true;
      } catch {
        return false;
      }
    });
  // Prefer nodes that fit without stopping existing groups; deterministic ties.
  candidates.sort(
    (a, b) =>
      Number(
        !fit(
          a,
          rankValue(variant.resources, 0),
          existing.flatMap((i) => i.nodes.filter((n) => n.nodeId === a.id).map((n) => n.resources)),
        ),
      ) -
        Number(
          !fit(
            b,
            rankValue(variant.resources, 0),
            existing.flatMap((i) =>
              i.nodes.filter((n) => n.nodeId === b.id).map((n) => n.resources),
            ),
          ),
        ) || a.id.localeCompare(b.id),
  );
  const selected = input.nodeIds
    ? input.nodeIds.map((id) => {
        const n = byId.get(id);
        if (!n) throw refusal("BAD_REQUEST", `Unknown node ${id}`);
        return n;
      })
    : candidates.slice(0, count);
  if (selected.length !== count || new Set(selected.map((n) => n.id)).size !== count)
    throw refusal("BAD_REQUEST", `Select exactly ${count} distinct nodes`);
  for (const n of selected) {
    gate(n);
    if (!nodeHasAllLabels(n.labels, variant.labels))
      throw refusal("BAD_REQUEST", `Node ${n.id} does not match labels`);
  }
  const stopIds = new Set<string>();
  // Conflict cascades remove all ranks of selected groups before recalculating fit.
  for (let index = 0; index < selected.length; index++) {
    const node = selected[index];
    if (!node) throw new Error("Missing node");
    const req = rankValue(variant.resources, index % variant.groupSize);
    const active = existing.filter((i) => !stopIds.has(i.id));
    const claims = active.flatMap((i) =>
      i.nodes.filter((n) => n.nodeId === node.id).map((n) => n.resources),
    );
    if (!fit(node, req, claims)) for (const id of conflicts(node, req, active)) stopIds.add(id);
  }
  const placements = selected.map((node, index) => {
    const rank = index % variant.groupSize;
    const active = existing.filter((i) => !stopIds.has(i.id));
    const resources = fit(
      node,
      rankValue(variant.resources, rank),
      active.flatMap((i) => i.nodes.filter((n) => n.nodeId === node.id).map((n) => n.resources)),
    );
    if (!resources) throw refusal("CONFLICT", `Requirements exceed usable budgets on ${node.id}`);
    // Stopping claims still own ports until confirmed stop: never reuse them now.
    const busy = new Set(
      existing.flatMap((i) =>
        i.nodes
          .filter((n) => n.nodeId === node.id)
          .flatMap((n) => (n.distPort === null ? [n.port] : [n.port, n.distPort])),
      ),
    );
    const ports: number[] = [];
    for (
      let p = node.portStart;
      p <= node.portEnd && ports.length < (variant.groupSize > 1 ? 2 : 1);
      p++
    )
      if (!busy.has(p)) ports.push(p);
    if (ports[0] === undefined || (variant.groupSize > 1 && ports[1] === undefined))
      throw refusal("CONFLICT", `No free deployment ports on ${node.id}`);
    return {
      nodeId: node.id,
      rank,
      group: Math.floor(index / variant.groupSize),
      resources,
      port: ports[0],
      distPort: ports[1] ?? null,
    };
  });
  const stops = existing.filter((i) => stopIds.has(i.id));
  const affectedNodeIds = [
    ...new Set([
      ...selected.map((n) => n.id),
      ...stops.flatMap((i) => i.nodes.map((n) => n.nodeId)),
    ]),
  ].sort();
  const affected = affectedNodeIds.map((id) => {
    const n = byId.get(id);
    if (!n) throw refusal("CONFLICT", `Stopped instance node ${id} is unavailable`);
    return n;
  });
  const permission = deploymentPermission(
    affected,
    stops,
    input.actor,
    new Set(stops.flatMap((i) => i.nodes.map((n) => n.nodeId))),
  );
  const head = selected[0];
  const headAddr =
    variant.groupSize === 1
      ? "127.0.0.1"
      : deploymentHeadAddress(head?.info.interfaces, variant.iface);
  if (!headAddr)
    throw refusal("BAD_REQUEST", "Head address is unavailable on the selected interface");
  return {
    placements,
    stopIds: [...stopIds].sort(),
    affectedNodeIds,
    ...permission,
    headAddr,
    warnings: [],
  };
}
export function deploymentFingerprint(value: unknown) {
  const canonical = (entry: unknown): unknown => {
    if (entry === null || typeof entry !== "object") return entry;
    if (entry instanceof Date) return entry.toJSON();
    if (Array.isArray(entry)) return entry.map(canonical);
    return Object.fromEntries(
      Object.entries(entry)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Characters every placeholder value is limited to: none is special to a shell. */
const PLACEHOLDER_VALUE = /^[A-Za-z0-9_.:,+-]*$/;
/**
 * Substitute placeholders bare. Values are numbers, GPU index lists, the
 * validated interface name, and a canonical IPv4 head address; refusing any
 * other character keeps a value inert in every shell position, including
 * inside a recipe's own quotes (where added quoting would break the value).
 */
export function renderDeploymentCommand(command: string, values: Record<string, string | number>) {
  const rendered = command.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw refusal("BAD_REQUEST", `Unknown deployment placeholder ${key}`);
    const text = String(value);
    if (!PLACEHOLDER_VALUE.test(text))
      throw refusal("BAD_REQUEST", `Deployment placeholder ${key} has an unsafe value`);
    return text;
  });
  // The CLI refuses a longer job command outright; substitution can lengthen a saved command,
  // and older stored revisions predate the saved-command byte limit.
  if (deploymentCommandBytes(rendered) > DEPLOYMENT_COMMAND_MAX_BYTES)
    throw refusal(
      "BAD_REQUEST",
      `A rendered deployment command exceeds ${DEPLOYMENT_COMMAND_MAX_BYTES} bytes`,
    );
  return rendered;
}
