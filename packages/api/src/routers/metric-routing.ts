/**
 * Metric-driven pool routing rules and remote metric sources (S-B part 2).
 * Mounted under `forwarderManagement` (see forwarder-management.ts).
 */
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import type { LiveNodeTelemetrySnapshot } from "../context";
import { protectedProcedure } from "../index";
import {
  describeSeries,
  type EndpointLoadSample,
  endpointLoadSeries,
  type MetricSeries,
  nodeMetricSeries,
  parseNodeMetricsSample,
  parseStoredRemoteMetricSources,
  parseStoredRoutingRules,
  type RemoteMetricSourceDefinition,
  remoteMetricSourceDefinitionsSchema,
  routingRulesSchema,
} from "../lib/metric-routing";

const idSchema = z.string().min(1);

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
    slotsBusy: load.slotsBusy,
    deferred: load.deferred,
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
          routingRules: true,
          PoolMembers: {
            where: { tier: "PRIMARY" },
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              DiscoveredModel: { select: memberModelSelect },
              ExecutionTarget: { select: { DiscoveredModel: { select: memberModelSelect } } },
            },
          },
        },
      });
      if (!pool) throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      const rules = parseStoredRoutingRules(pool.routingRules);
      const members = pool.PoolMembers.flatMap((member) => {
        const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
        return model ? [{ id: member.id, model }] : [];
      });
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
      const now = new Date();
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
   * Replace a pool's routing rules. `full` makes a member FULL (the request
   * queues, goes to another member, or goes external for `:external`
   * callers); `avoid` ranks it last. Stale or missing metrics are ignored.
   * The pool's stored verdicts are cleared so the new rules apply at the
   * device's next metrics frame.
   */
  setPoolRoutingRules: protectedProcedure
    .input(z.object({ poolId: idSchema, rules: routingRulesSchema }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;
      // Single statements: a non-key JSON column (FOR NO KEY UPDATE, which
      // admission's FK KEY SHARE admits) and the H-class verdict table (no
      // foreign keys). No capacity lock is held or taken.
      const updated = await prisma.modelPool.updateMany({
        where: { id: input.poolId, userId },
        data: { routingRules: input.rules },
      });
      if (updated.count === 0) {
        throw new ORPCError("NOT_FOUND", { message: "Model pool not found." });
      }
      await prisma.poolMemberRoutingVerdict.deleteMany({ where: { poolId: input.poolId } });
      return { poolId: input.poolId, rules: input.rules };
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
        /** False when the CLI is offline here; it gets them at its next hello. */
        delivered,
        note: "The CLI runs a remote source only with its local opt-in (allowRemoteMetricSources) and after `wsmp metrics approve <name>`; it reports each source's state in node.metrics.",
      };
    }),
};
