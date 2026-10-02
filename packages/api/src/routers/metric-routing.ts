/**
 * Metric-driven pool routing rules and remote metric sources (S-B part 2).
 * Mounted under `forwarderManagement` (see forwarder-management.ts).
 */
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { fenceOwners } from "@ws-model-proxy/db/capacity-lock-order";
import { z } from "zod";
import type { LiveNodeTelemetrySnapshot } from "../context";
import { protectedProcedure } from "../index";
import {
  DEFAULT_KV_FULL_THRESHOLD,
  effectiveKvFullThreshold,
  engineHasLoadSignal,
  engineKindFromDb,
  evaluateEngineLoad,
} from "../lib/engine-load";
import {
  effectiveKvBudgetTokens,
  effectiveKvCut,
  KV_EVICTION_FLOOR_FRACTION,
  kvEvictionCutsApply,
  protectionKvBudgetTokens,
} from "../lib/kv-eviction-budget";
import {
  describeSeries,
  ENDPOINT_LOAD_STALE_AFTER_MS,
  type EndpointLoadSample,
  endpointLoadSeries,
  engineLoadHistoryKey,
  engineLoadHistoryLookupKeys,
  idSchema,
  type MetricSeries,
  nodeMetricSeries,
  parseNodeMetricsSample,
  parseStoredRemoteMetricSources,
  pickEndpointLoad,
  pickEngineLoadHistorySeries,
  type RemoteMetricSourceDefinition,
  remoteMetricSourceDefinitionsSchema,
  routingRulesFromRows,
  routingRulesSchema,
  scopedRoutingMemberIds,
} from "../lib/metric-routing";
import {
  remoteEngineAdapterDefinitionsSchema,
  serializeRemoteEngineAdapters,
} from "../lib/remote-engine-adapters";

function commandSha256(command: string): string {
  return createHash("sha256").update(command, "utf8").digest("hex");
}

/** Server-stored remote definitions, with the hash the CLI pins on approval. */
export function serializeRemoteMetricSources(value: unknown) {
  return parseStoredRemoteMetricSources(value).map((source: RemoteMetricSourceDefinition) => ({
    ...source,
    commandSha256: commandSha256(source.command),
  }));
}

/** Built-in and custom series of a device's freshest (or stored) `node.metrics`. */
export function deviceMetricSeries(
  nodeMetrics: unknown,
  receivedAt: Date | null,
  now: Date,
): MetricSeries[] {
  const sample = parseNodeMetricsSample(nodeMetrics);
  if (!sample || !receivedAt) return [];
  return nodeMetricSeries(sample, receivedAt, now);
}

function liveEndpointLoad(live: LiveNodeTelemetrySnapshot | null): EndpointLoadSample[] {
  return (live?.endpointLoad ?? []).map((load) => ({
    endpointSlug: load.endpointSlug,
    modelSlug: load.modelSlug,
    running: load.running,
    waiting: load.waiting,
    kvUsage: load.kvUsage,
    kvOccupancy: load.kvOccupancy,
    slotsBusy: load.slotsBusy,
    deferred: load.deferred,
    source: load.source,
    waitingStreak: load.waitingStreak,
    prefixCacheHitsTotal: load.prefixCacheHitsTotal,
    prefixCacheQueriesTotal: load.prefixCacheQueriesTotal,
    receivedAt: load.receivedAt,
  }));
}

const verdictFromDb = { NONE: "none", AVOID: "avoid", FULL: "full" } as const;

const memberModelSelect = {
  slug: true,
  upstreamModelId: true,
  Endpoint: {
    select: {
      slug: true,
      cliDeviceId: true,
      CliDevice: { select: { slug: true, name: true, reportedHostname: true } },
    },
  },
} as const;

export const metricRoutingProcedures = {
  /**
   * A pool's routing rules, each primary member's current verdict (with a
   * per-rule `triggered` / `clear` / `stale` state), and the metrics its
   * members' devices report, for discovery.
   */
  getPoolRoutingRules: protectedProcedure
    .input(z.object({ poolId: idSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const pool = await prisma.modelPool.findFirst({
        where: { id: input.poolId, userId },
        select: {
          id: true,
          slug: true,
          protectionEnabled: true,
          evictionFeedbackEnabled: true,
          PoolRoutingRules: {
            orderBy: { position: "asc" },
            select: {
              position: true,
              metric: true,
              labels: true,
              aggregate: true,
              op: true,
              threshold: true,
              effect: true,
              memberId: true,
              exclude: true,
            },
          },
          PoolMembers: {
            where: { tier: "PRIMARY" },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              engineLoadMode: true,
              customEngineLoadMode: true,
              kvFullThreshold: true,
              DiscoveredModel: { select: memberModelSelect },
              ExecutionTarget: {
                select: {
                  InferenceCapacity: {
                    select: {
                      id: true,
                      engineKind: true,
                      engineSlots: true,
                      kvBudgetTokens: true,
                      kvBudgetTokensSource: true,
                      engineLoadSource: true,
                      engineLoadSignals: true,
                    },
                  },
                  DiscoveredModel: { select: memberModelSelect },
                },
              },
            },
          },
        },
      });
      if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      const rules = routingRulesFromRows(pool.PoolRoutingRules);
      const members = pool.PoolMembers.flatMap((member) => {
        const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
        return model
          ? [
              {
                id: member.id,
                model,
                engineLoadMode: member.engineLoadMode,
                customEngineLoadMode: member.customEngineLoadMode,
                kvFullThreshold: member.kvFullThreshold,
                capacity: member.ExecutionTarget?.InferenceCapacity ?? null,
              },
            ]
          : [];
      });
      // Clears retain NONE rows as successor fences. Their ruleStates and
      // engineState remain historical snapshots until the member is rewritten;
      // the expiry check below and live engine evaluation still apply.
      const now = new Date();
      const kvEvictions = await prisma.capacityKvEviction
        .findMany({
          where: {
            capacityId: {
              in: [...new Set(members.flatMap(({ capacity }) => (capacity ? [capacity.id] : [])))],
            },
            userId,
            expiresAt: { gt: now },
          },
        })
        .catch(() => []);
      const kvEvictionByCapacity = new Map(kvEvictions.map((row) => [row.capacityId, row]));
      const verdicts = await prisma.poolMemberRoutingVerdict.findMany({
        where: { poolId: pool.id, poolMemberId: { in: members.map((member) => member.id) } },
      });
      const verdictByMember = new Map(verdicts.map((row) => [row.poolMemberId, row]));
      const deviceIds = [...new Set(members.map((member) => member.model.Endpoint.cliDeviceId))];
      const live = context.services?.getLiveNodeTelemetry?.(deviceIds);
      const stored = deviceIds.length
        ? await prisma.cliDevice.findMany({
            where: { id: { in: deviceIds }, userId },
            select: { id: true, nodeMetrics: true, nodeMetricsAt: true },
          })
        : [];
      const storedById = new Map(stored.map((row) => [row.id, row]));
      const devices = deviceIds.map((cliDeviceId) => {
        const snapshot = live?.get(cliDeviceId) ?? null;
        const device = members.find((member) => member.model.Endpoint.cliDeviceId === cliDeviceId)
          ?.model.Endpoint.CliDevice;
        const row = storedById.get(cliDeviceId);
        const series = snapshot?.nodeMetrics
          ? deviceMetricSeries(snapshot.nodeMetrics, snapshot.nodeMetricsReceivedAt, now)
          : deviceMetricSeries(row?.nodeMetrics ?? null, row?.nodeMetricsAt ?? null, now);
        return {
          cliDeviceId,
          label: device?.name ?? device?.reportedHostname ?? device?.slug ?? cliDeviceId,
          live: snapshot !== null,
          series: describeSeries(series),
        };
      });
      return {
        poolId: pool.id,
        poolSlug: pool.slug,
        rules,
        members: members.map((member) => {
          const verdict = verdictByMember.get(member.id);
          const expired = !verdict || verdict.expiresAt <= now;
          const ruleStates = Array.isArray(verdict?.ruleStates)
            ? verdict.ruleStates.filter((state): state is string => typeof state === "string")
            : [];
          const snapshot = live?.get(member.model.Endpoint.cliDeviceId) ?? null;
          const memberRef = {
            endpointSlug: member.model.Endpoint.slug,
            modelSlug: member.model.slug ?? null,
          };
          const reading = pickEndpointLoad(liveEndpointLoad(snapshot), memberRef);
          const engineKind = engineKindFromDb(member.capacity?.engineKind);
          const loadSource =
            member.capacity?.engineLoadSource === "CUSTOM" || reading?.source === "custom"
              ? ("custom" as const)
              : ("builtin" as const);
          const engineVerdict = evaluateEngineLoad(
            {
              engineKind,
              engineSlots: member.capacity?.engineSlots ?? null,
              mode: member.engineLoadMode === "OFF" ? "OFF" : "AUTO",
              kvFullThreshold: member.kvFullThreshold,
              loadSource,
              signals: member.capacity?.engineLoadSignals ?? [],
              customMode: member.customEngineLoadMode === "ENFORCE" ? "ENFORCE" : "OBSERVE",
            },
            reading ? { ...reading, waitingStreak: reading.waitingStreak ?? 0 } : null,
            now,
          );
          const kvState = member.capacity
            ? kvEvictionByCapacity.get(member.capacity.id)
            : undefined;
          const reportedTokens = protectionKvBudgetTokens(
            member.capacity?.engineKind,
            member.capacity?.kvBudgetTokens ?? null,
          );
          const protectionEnabled = pool.protectionEnabled;
          const applyCuts = kvEvictionCutsApply(pool.evictionFeedbackEnabled);
          const placementTokens = effectiveKvBudgetTokens(
            reportedTokens,
            kvState,
            now,
            pool.evictionFeedbackEnabled,
          );
          const effectiveTokens = protectionEnabled ? placementTokens : reportedTokens;
          const cutFraction =
            !protectionEnabled || !applyCuts || effectiveTokens === null
              ? 0
              : effectiveKvCut(kvState, now);
          return {
            poolMemberId: member.id,
            upstreamModelId: member.model.upstreamModelId,
            endpointSlug: member.model.Endpoint.slug,
            cliDeviceId: member.model.Endpoint.cliDeviceId,
            verdict: verdict && !expired ? verdictFromDb[verdict.verdict] : null,
            /**
             * `active`: a fresh verdict holds; `stale`: the last verdict
             * expired (its metrics went stale, the rule is ignored);
             * `unevaluated`: no verdict yet.
             */
            state: !verdict ? "unevaluated" : expired ? "stale" : "active",
            ruleStates: verdict ? ruleStates : [],
            evaluatedAt: verdict?.evaluatedAt ?? null,
            expiresAt: verdict?.expiresAt ?? null,
            /**
             * Live engine load (S-D). `state` is this process's own reading;
             * `snapshotState` is what the shared verdict row last recorded.
             * `mode` off ignores engine load for the member.
             */
            engineLoad: {
              kvBudget: {
                reportedTokens,
                effectiveTokens,
                placementTokens,
                source:
                  reportedTokens == null ? null : (member.capacity?.kvBudgetTokensSource ?? null),
                cutFraction,
                floorFraction: KV_EVICTION_FLOOR_FRACTION,
                lastObservedAt: kvState?.observedAt ?? null,
                expiresAt: kvState?.expiresAt ?? null,
                active: protectionEnabled && effectiveTokens !== null && cutFraction > 0,
              },
              mode: member.engineLoadMode === "OFF" ? ("off" as const) : ("auto" as const),
              customMode:
                member.customEngineLoadMode === "ENFORCE"
                  ? ("enforce" as const)
                  : ("observe" as const),
              kvFullThreshold: member.kvFullThreshold,
              effectiveKvFullThreshold: effectiveKvFullThreshold(member.kvFullThreshold),
              engineKind,
              engineSlots: member.capacity?.engineSlots ?? null,
              loadSource,
              signals: member.capacity?.engineLoadSignals ?? [],
              hasSignal: engineHasLoadSignal(engineKind, {
                loadSource,
                signals: member.capacity?.engineLoadSignals ?? [],
              }),
              state: engineVerdict.state,
              full: engineVerdict.full,
              enforced: engineVerdict.enforced,
              snapshotState:
                verdict && !expired && verdict.verdict === "FULL" ? verdict.engineState : null,
              live: reading
                ? {
                    running: reading.running,
                    waiting: reading.waiting,
                    kvUsage: reading.kvUsage ?? null,
                    kvOccupancy: reading.kvOccupancy ?? null,
                    slotsBusy: reading.slotsBusy ?? null,
                    deferred: reading.deferred ?? null,
                    waitingStreak: reading.waitingStreak ?? 0,
                    ageSeconds: Math.round((now.getTime() - reading.receivedAt.getTime()) / 1000),
                    stale:
                      now.getTime() - reading.receivedAt.getTime() > ENDPOINT_LOAD_STALE_AFTER_MS,
                    prefixCacheHits: reading.prefixCacheHitsTotal ?? 0,
                    prefixCacheQueries: reading.prefixCacheQueriesTotal ?? 0,
                  }
                : null,
            },
            endpointSeries: describeSeries(
              endpointLoadSeries(
                liveEndpointLoad(snapshot),
                {
                  endpointSlug: member.model.Endpoint.slug,
                  modelSlug: member.model.slug ?? null,
                },
                now,
              ),
            ),
          };
        }),
        devices,
      };
    }),

  /**
   * 30-minute live engine-load history (10 s buckets) for a pool or capacity
   * the caller owns. A foreign id is NOT_FOUND. Occupancy is display-only.
   */
  getEngineLoadHistory: protectedProcedure
    .input(z.union([z.object({ poolId: idSchema }), z.object({ capacityId: idSchema })]))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const now = new Date();
      type HistoryMember = {
        poolMemberId: string | null;
        capacityId: string | null;
        endpointSlug: string;
        modelSlug: string | null;
        cliDeviceId: string;
        engineLoadSource: string | null;
        engineLoadSignals: string[];
        kvFullThreshold: number | null;
        kvBudgetTokens: number | null;
      };
      let members: HistoryMember[] = [];
      if ("poolId" in input) {
        const pool = await prisma.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: {
            PoolMembers: {
              where: { tier: "PRIMARY" },
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                kvFullThreshold: true,
                DiscoveredModel: { select: memberModelSelect },
                ExecutionTarget: {
                  select: {
                    InferenceCapacity: {
                      select: {
                        id: true,
                        kvBudgetTokens: true,
                        engineLoadSource: true,
                        engineLoadSignals: true,
                      },
                    },
                    DiscoveredModel: { select: memberModelSelect },
                  },
                },
              },
            },
          },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        members = pool.PoolMembers.flatMap((member) => {
          const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
          if (!model) return [];
          const capacity = member.ExecutionTarget?.InferenceCapacity ?? null;
          return [
            {
              poolMemberId: member.id,
              capacityId: capacity?.id ?? null,
              endpointSlug: model.Endpoint.slug,
              modelSlug: model.slug ?? null,
              cliDeviceId: model.Endpoint.cliDeviceId,
              engineLoadSource: capacity?.engineLoadSource ?? null,
              engineLoadSignals: capacity?.engineLoadSignals ?? [],
              kvFullThreshold: member.kvFullThreshold,
              kvBudgetTokens: capacity?.kvBudgetTokens ?? null,
            },
          ];
        });
      } else {
        const capacity = await prisma.inferenceCapacity.findFirst({
          where: { id: input.capacityId, userId },
          select: {
            id: true,
            kvBudgetTokens: true,
            engineLoadSource: true,
            engineLoadSignals: true,
            ExecutionTargets: {
              select: { DiscoveredModel: { select: memberModelSelect } },
            },
          },
        });
        if (!capacity) throw new ORPCError("NOT_FOUND", { message: "Capacity not found." });
        members = capacity.ExecutionTargets.flatMap((target) => {
          const model = target.DiscoveredModel;
          if (!model) return [];
          return [
            {
              poolMemberId: null,
              capacityId: capacity.id,
              endpointSlug: model.Endpoint.slug,
              modelSlug: model.slug ?? null,
              cliDeviceId: model.Endpoint.cliDeviceId,
              engineLoadSource: capacity.engineLoadSource,
              engineLoadSignals: capacity.engineLoadSignals,
              kvFullThreshold: null,
              kvBudgetTokens: capacity.kvBudgetTokens,
            },
          ];
        });
      }
      const keys = engineLoadHistoryLookupKeys(members);
      const history = context.services?.getLiveEngineLoadHistory?.(keys, now) ?? [];
      const byKey = new Map(
        history.map((entry) => [
          engineLoadHistoryKey(entry.cliDeviceId, entry.endpointSlug, entry.modelSlug),
          entry.series,
        ]),
      );
      return {
        members: members.map((member) => ({
          poolMemberId: member.poolMemberId,
          capacityId: member.capacityId,
          endpointSlug: member.endpointSlug,
          modelSlug: member.modelSlug,
          cliDeviceId: member.cliDeviceId,
          source: member.engineLoadSource === "CUSTOM" ? ("custom" as const) : ("builtin" as const),
          signals: member.engineLoadSignals,
          effectiveKvFullThreshold: effectiveKvFullThreshold(member.kvFullThreshold),
          kvBudgetTokens: member.kvBudgetTokens,
          series: pickEngineLoadHistorySeries(byKey, member),
        })),
      };
    }),

  /**
   * Replace a pool's routing rules. `full` makes a member FULL (the request
   * queues, goes to another member, or goes external for `:external`
   * callers); `avoid` ranks it last. `memberId` limits a rule to that member;
   * `excludeMemberId` applies it to every other member. Stale or missing
   * metrics are ignored. The pool's stored gating (FULL and AVOID) verdicts
   * are cleared so the new rules apply at the device's next metrics frame.
   */
  setPoolRoutingRules: protectedProcedure
    .input(z.object({ poolId: idSchema, rules: routingRulesSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      // Graph table replace under the owner fence. The stored gating verdicts
      // are H-class rows: they are cleared afterwards by the relay (H module),
      // never by this M writer.
      await prisma.$transaction(async (tx) => {
        await fenceOwners(tx, [userId]);
        await tx.$queryRaw`
          SELECT id FROM model_pool
           WHERE id = ${input.poolId} AND "userId" = ${userId}
           FOR NO KEY UPDATE`;
        const pool = await tx.modelPool.findFirst({
          where: { id: input.poolId, userId },
          select: { id: true, PoolMembers: { select: { id: true, tier: true } } },
        });
        if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
        const primaryIds = new Set(
          pool.PoolMembers.filter((member) => member.tier === "PRIMARY").map((member) => member.id),
        );
        const unknown = scopedRoutingMemberIds(input.rules).filter((id) => !primaryIds.has(id));
        if (unknown.length > 0) {
          throw new ORPCError("BAD_REQUEST", {
            message: "memberId and excludeMemberId must name PRIMARY members of this pool.",
          });
        }
        await tx.poolRoutingRule.deleteMany({ where: { poolId: pool.id } });
        if (input.rules.length === 0) return;
        await tx.poolRoutingRule.createMany({
          data: input.rules.map((rule, position) => ({
            poolId: pool.id,
            position,
            metric: rule.metric,
            labels: rule.labels ?? Prisma.DbNull,
            aggregate: rule.aggregate,
            op: rule.op,
            threshold: rule.threshold,
            effect: rule.effect,
            memberId: rule.memberId ?? rule.excludeMemberId ?? null,
            exclude: Boolean(rule.excludeMemberId),
          })),
        });
      });
      await context.services?.onPoolRoutingRulesChanged?.(input.poolId);
      return { poolId: input.poolId, rules: input.rules };
    }),

  /**
   * Per-member live engine load override (S-D). `auto` lets the engine's live
   * load (`endpoint.load`) mark the member FULL; `off` ignores it. The optional
   * `kvFullThreshold` (0-1) overrides the 0.95 default for vLLM/SGLang; null
   * clears it. The relay (H) clears the pool's stored gating verdicts (NONE fences stay). A changed
   * override invalidates this member's cache in every process, so it is
   * re-published at the device's next evaluation. Unchanged siblings follow
   * the regular refresh budget when their session is on another process.
   */
  setPoolMemberEngineLoad: protectedProcedure
    .input(
      z.object({
        poolMemberId: idSchema,
        mode: z.enum(["auto", "off"]),
        customMode: z.enum(["observe", "enforce"]).optional(),
        kvFullThreshold: z.number().gt(0).max(1).nullable().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      // One graph statement (non-key columns): no capacity lock is held or
      // taken. The stored gating verdicts are H-class rows: the relay clears them
      // afterwards (`onPoolRoutingRulesChanged`), never this M writer.
      const updated = await prisma.poolMember.updateMany({
        where: { id: input.poolMemberId, ModelPool: { userId } },
        data: {
          engineLoadMode: input.mode === "off" ? "OFF" : "AUTO",
          ...(input.customMode !== undefined
            ? { customEngineLoadMode: input.customMode === "enforce" ? "ENFORCE" : "OBSERVE" }
            : {}),
          ...(input.kvFullThreshold !== undefined
            ? { kvFullThreshold: input.kvFullThreshold }
            : {}),
        },
      });
      if (updated.count === 0) {
        throw new ORPCError("NOT_FOUND", { message: "Pool member not found." });
      }
      const member = await prisma.poolMember.findFirst({
        where: { id: input.poolMemberId, ModelPool: { userId } },
        select: {
          id: true,
          poolId: true,
          engineLoadMode: true,
          customEngineLoadMode: true,
          kvFullThreshold: true,
        },
      });
      if (member) await context.services?.onPoolRoutingRulesChanged?.(member.poolId);
      return {
        poolMemberId: input.poolMemberId,
        mode: member?.engineLoadMode === "OFF" ? ("off" as const) : ("auto" as const),
        customMode:
          member?.customEngineLoadMode === "ENFORCE" ? ("enforce" as const) : ("observe" as const),
        kvFullThreshold: member?.kvFullThreshold ?? null,
        defaultKvFullThreshold: DEFAULT_KV_FULL_THRESHOLD,
      };
    }),

  /**
   * Replace a device's remotely defined metric sources. Allowed only while
   * the device's MCP command mode is `unsupervised`. The CLI still refuses
   * them without its local opt-in (`allowRemoteMetricSources`) and runs each
   * command only after a local, hash-pinned approval (`wsmp metrics approve`);
   * a changed command needs approval again.
   */
  setCliDeviceMetricSources: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema, sources: remoteMetricSourceDefinitionsSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const device = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, mcpCommandMode: true },
      });
      if (!device || device.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      if (device.mcpCommandMode !== "UNSUPERVISED") {
        throw new ORPCError("BAD_REQUEST", {
          message: "Remote metric sources need this device's MCP command mode to be unsupervised.",
        });
      }
      // Re-checked in the write: a concurrent downgrade of the mode wins.
      const updated = await prisma.cliDevice.updateMany({
        where: { id: device.id, userId, mcpCommandMode: "UNSUPERVISED" },
        data: { remoteMetricSources: input.sources, remoteMetricSourcesAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ORPCError("CONFLICT", {
          message: "This device's MCP command mode changed; remote metric sources were not saved.",
        });
      }
      const delivered =
        (await context.services?.onRemoteMetricSourcesChanged?.(device.id)) ?? false;
      return {
        cliDeviceId: device.id,
        sources: serializeRemoteMetricSources(input.sources),
        /**
         * False when the CLI is offline here (it gets them at its next hello)
         * or the push could not read the device and sent a withdrawal (an
         * empty list, fail closed): save again to retry.
         */
        delivered,
        note: "The CLI runs a remote source only with its local opt-in (allowRemoteMetricSources) and after `wsmp metrics approve <name> --sha256 <hash>` (the hash of the command the person read); it reports each source's state in node.metrics.",
      };
    }),

  /**
   * Replace a device's remotely defined engine adapters. Allowed only while
   * the device's MCP command mode is `unsupervised`. The CLI still refuses
   * them without its separate local opt-in (`allowRemoteEngineAdapters`) and
   * runs each spec only after a local, hash-pinned approval; a changed spec
   * needs approval again. Metric-source opt-in does not allow adapters.
   */
  setCliDeviceEngineAdapters: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema, adapters: remoteEngineAdapterDefinitionsSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const device = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, mcpCommandMode: true },
      });
      if (!device || device.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      if (device.mcpCommandMode !== "UNSUPERVISED") {
        throw new ORPCError("BAD_REQUEST", {
          message: "Remote engine adapters need this device's MCP command mode to be unsupervised.",
        });
      }
      const updated = await prisma.cliDevice.updateMany({
        where: { id: device.id, userId, mcpCommandMode: "UNSUPERVISED" },
        data: { remoteEngineAdapters: input.adapters, remoteEngineAdaptersAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ORPCError("CONFLICT", {
          message: "This device's MCP command mode changed; remote engine adapters were not saved.",
        });
      }
      const delivered =
        (await context.services?.onRemoteEngineAdaptersChanged?.(device.id)) ?? false;
      return {
        cliDeviceId: device.id,
        adapters: serializeRemoteEngineAdapters(input.adapters),
        delivered,
        note: "The CLI runs a remote adapter only with its local opt-in (allowRemoteEngineAdapters) and after `wsmp endpoints adapter approve <slug> --sha256 <hash>` (the hash of the canonical spec the person read); it reports each adapter's state in node.metrics.engineAdapters. Metric-source opt-in does not allow adapters.",
      };
    }),

  /**
   * Clear a device's remotely defined engine adapters (same unsupervised
   * gate as set). Sends an empty list to the live CLI.
   */
  clearCliDeviceEngineAdapters: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      const device = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, mcpCommandMode: true },
      });
      if (!device || device.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      if (device.mcpCommandMode !== "UNSUPERVISED") {
        throw new ORPCError("BAD_REQUEST", {
          message: "Remote engine adapters need this device's MCP command mode to be unsupervised.",
        });
      }
      const updated = await prisma.cliDevice.updateMany({
        where: { id: device.id, userId, mcpCommandMode: "UNSUPERVISED" },
        data: { remoteEngineAdapters: [], remoteEngineAdaptersAt: new Date() },
      });
      if (updated.count === 0) {
        throw new ORPCError("CONFLICT", {
          message:
            "This device's MCP command mode changed; remote engine adapters were not cleared.",
        });
      }
      const delivered =
        (await context.services?.onRemoteEngineAdaptersChanged?.(device.id)) ?? false;
      return { cliDeviceId: device.id, adapters: [], delivered };
    }),
};
