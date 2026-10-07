/**
 * Proactive learning of what each engine accepts: once per instance incarnation that is READY
 * (a restart changes its cache generation), the server asks the engine for its OpenAPI
 * description through the instance's head node (`GET /openapi.json`, which the node relays only
 * to an engine on its own loopback) and stores the accepted request fields per launch. Bounded:
 * a few probes per tick, 4 MiB and 10 s per description; an engine without one is noted and
 * not asked again until it restarts; any other failure is simply retried after a restart.
 */
import { createHash } from "node:crypto";
import prisma from "@ws-model-proxy/db";
import { type RelayAttempt, startRelayAttempt } from "../relay-executor.js";
import { acceptedProfileFromOpenApi, openApiEngineVersion } from "./openapi-profile.js";
import {
  type LaunchKey,
  markProbedWithoutDescription,
  saveDescribedProfile,
} from "./profile-store.js";
import { peekStream } from "./send.js";

export const PROBE_INTERVAL_MS = 30_000;
const PROBES_PER_TICK = 8;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION_BYTES = 4 * 1024 * 1024;
const MAX_REMEMBERED = 10_000;
/** A probe that failed (timeout, node reconnect) is tried again this many times in all. */
const MAX_TRIES = 3;

type ProbeManager = Parameters<typeof startRelayAttempt>[0]["manager"] & {
  getOnlineNodeIds(): Iterable<string>;
};

export type ProbeTarget = {
  instanceId: string;
  generation: string;
  nodeId: string;
  handle: string;
  key: LaunchKey;
};

/** READY model-serving instances whose head node is online. */
async function readyTargets(onlineNodeIds: Set<string>): Promise<ProbeTarget[]> {
  const rows = await prisma.runtimeInstance.findMany({
    where: { phase: "READY", Version: { modelType: { not: null } } },
    select: {
      id: true,
      userId: true,
      runtimeId: true,
      handle: true,
      cacheGeneration: true,
      Version: { select: { launchHash: true } },
      Runtime: { select: { kind: true, nodeId: true } },
      Ranks: { where: { rank: 0 }, select: { nodeId: true } },
    },
    // The most recently ready first: a new incarnation is asked within a tick or two.
    orderBy: [{ phaseChangedAt: "desc" }, { id: "asc" }],
    take: 500,
  });
  return rows.flatMap((row) => {
    const nodeId = row.Runtime.kind === "ALWAYS_ON" ? row.Runtime.nodeId : row.Ranks[0]?.nodeId;
    if (!nodeId || !onlineNodeIds.has(nodeId)) return [];
    return [
      {
        instanceId: row.id,
        generation: row.cacheGeneration,
        nodeId,
        handle: row.handle,
        key: { userId: row.userId, runtimeId: row.runtimeId, launchHash: row.Version.launchHash },
      },
    ];
  });
}

export type ProbeOutcome = "described" | "undescribed" | "failed";

/** Asks one engine for its description and stores what it says. */
export async function probeEngineDescription(
  manager: ProbeManager,
  target: ProbeTarget,
  now = () => new Date(),
): Promise<ProbeOutcome> {
  let attempt: RelayAttempt | null = null;
  try {
    attempt = startRelayAttempt({
      manager,
      nodeId: target.nodeId,
      handle: target.handle,
      family: "generic",
      method: "GET",
      path: "/openapi.json",
      headers: new Headers({ accept: "application/json" }),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const started = await attempt.started;
    if (started.status === 404 || started.status === 405) {
      await started.body.cancel().catch(() => undefined);
      await markProbedWithoutDescription(target.key, now());
      return "undescribed";
    }
    if (started.status < 200 || started.status >= 300) {
      await started.body.cancel().catch(() => undefined);
      return "failed";
    }
    const peeked = await peekStream(started.body, MAX_DESCRIPTION_BYTES);
    if (!peeked.complete) {
      attempt.cancel("request_too_large");
      return "failed";
    }
    let document: unknown;
    try {
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(peeked.prefix));
    } catch {
      await markProbedWithoutDescription(target.key, now());
      return "undescribed";
    }
    const accepted = acceptedProfileFromOpenApi(document);
    if (!accepted) {
      await markProbedWithoutDescription(target.key, now());
      return "undescribed";
    }
    const digest = createHash("sha256").update(peeked.prefix).digest("hex").slice(0, 16);
    await saveDescribedProfile(
      target.key,
      {
        accepted,
        engineFingerprint: `${openApiEngineVersion(document) ?? "openapi"} sha256:${digest}`,
      },
      now(),
    );
    return "described";
  } catch {
    attempt?.cancel("unknown");
    return "failed";
  }
}

/**
 * Starts the periodic probe sweep (unref'd). Returns its stop, which waits for a running sweep.
 */
export function startRequestProfileProbes(manager: ProbeManager): () => Promise<void> {
  /** Per instance: the incarnation asked, and how many tries it took so far. */
  const probed = new Map<string, { generation: string; tries: number; done: boolean }>();
  let running: Promise<void> | null = null;
  let stopped = false;
  const sweep = async () => {
    const targets = await readyTargets(new Set(manager.getOnlineNodeIds()));
    const due = targets
      .filter((target) => {
        const seen = probed.get(target.instanceId);
        return (
          !seen || seen.generation !== target.generation || (!seen.done && seen.tries < MAX_TRIES)
        );
      })
      .slice(0, PROBES_PER_TICK);
    for (const target of due) {
      if (stopped) return;
      const outcome = await probeEngineDescription(manager, target);
      const seen = probed.get(target.instanceId);
      const tries = seen?.generation === target.generation ? seen.tries + 1 : 1;
      if (probed.size >= MAX_REMEMBERED) probed.clear();
      probed.set(target.instanceId, {
        generation: target.generation,
        tries,
        done: outcome !== "failed",
      });
    }
  };
  const tick = () => {
    if (running) return;
    running = sweep()
      .catch((error: unknown) => {
        console.error(
          "[server] engine description probe failed",
          error instanceof Error ? error.constructor.name : typeof error,
        );
      })
      .finally(() => {
        running = null;
      });
  };
  const first = setTimeout(tick, 5_000);
  first.unref();
  const timer = setInterval(tick, PROBE_INTERVAL_MS);
  timer.unref();
  return async () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    await running;
  };
}
