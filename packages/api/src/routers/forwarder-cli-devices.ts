import { ORPCError } from "@orpc/server";
import { cliDeviceDisplayName } from "@ws-model-proxy/config/cli-device-name";
import { directModelId, poolModelId } from "@ws-model-proxy/config/forwarder-identifiers";
import { OVERVIEW_RANGE_CONFIG } from "@ws-model-proxy/config/usage-metrics";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { fenceParentDelete } from "@ws-model-proxy/db/capacity-lock-order";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  closeRevokedCliCredentialSessions,
  deleteCliDeviceAndCredentials,
} from "../lib/cli-credential-access";
import { deletionConflict } from "../lib/deletion-conflict";
import {
  deleteOrphanAutoCapacities,
  refreshSharedAutoCapacities,
} from "../lib/engine-process-capacity";
import {
  MCP_COMMAND_MODES,
  mcpCommandModeAtLeast,
  mcpCommandModeFromDb,
  mcpCommandModeToDb,
} from "../lib/mcp-command-mode";
import { describeSeries } from "../lib/metric-routing";
import {
  assertUsableBudgetWrite,
  nodeLabelsSchema,
  nodeUsableBudgetsInputSchema,
  normalizeNodeLabels,
  parseNodeInfo,
  shapeNodeMetricsRange,
  tryShapeNodeMetricsMinute,
} from "../lib/node-inventory";
import { overviewWindow } from "../lib/overview-metrics";
import {
  capabilityEditImpactedPools,
  discoveredModelPoolMemberWhere,
  poolIdsWithMembers,
} from "../lib/pool-capability-impact";
import { serializeRemoteEngineAdapters } from "../lib/remote-engine-adapters";
import { runCapacityDeleteTransaction } from "../lib/serializable-transaction";
import {
  cliDeviceSummarySelect,
  listCliDevicesSelect,
  serializeCliDevice,
  serializeCliDeviceNode,
  serializeCliDeviceSummary,
} from "./forwarder-serializers";
import {
  cliDeviceNameSchema,
  encodeSummaryCursor,
  idSchema,
  slugSchema,
  slugValidationError,
  summaryPageInput,
  summaryPageWhere,
} from "./forwarder-shared";
import { deviceMetricSeries, serializeRemoteMetricSources } from "./metric-routing";

type UserSlugRow = {
  id: string;
  slug: string;
};

async function currentUserSlug(userId: string): Promise<UserSlugRow> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, slug: true },
  });
  if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found." });
  return user;
}

async function assertUserSlugAvailable(slug: string, currentUserId: string) {
  const validationError = slugValidationError(slug);
  if (validationError) throw validationError;

  const existing = await prisma.user.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (existing && existing.id !== currentUserId) {
    throw new ORPCError("CONFLICT", { message: "forwarderSlug.taken" });
  }
}

async function userSlugChangePreview({ userId, nextSlug }: { userId: string; nextSlug: string }) {
  const user = await currentUserSlug(userId);
  await assertUserSlugAvailable(nextSlug, userId);

  const [directRows, poolRows] = await Promise.all([
    prisma.discoveredModel.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        upstreamModelId: true,
        Endpoint: {
          select: {
            slug: true,
            CliDevice: { select: { slug: true } },
          },
        },
      },
    }),
    prisma.modelPool.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        slug: true,
        name: true,
      },
    }),
  ]);

  const directModels = directRows.map((model) => ({
    kind: "DIRECT_MODEL" as const,
    id: model.id,
    upstreamModelId: model.upstreamModelId,
    currentModelId: directModelId({
      userSlug: user.slug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
    nextModelId: directModelId({
      userSlug: nextSlug,
      cliSlug: model.Endpoint.CliDevice.slug,
      endpointSlug: model.Endpoint.slug,
      upstreamModelId: model.upstreamModelId,
    }),
  }));

  const modelPools = poolRows.map((pool) => ({
    kind: "MODEL_POOL" as const,
    id: pool.id,
    name: pool.name,
    currentModelId: poolModelId({ userSlug: user.slug, poolSlug: pool.slug }),
    nextModelId: poolModelId({ userSlug: nextSlug, poolSlug: pool.slug }),
  }));

  return {
    currentSlug: user.slug,
    nextSlug,
    willChange: user.slug !== nextSlug,
    affectedModels: [...directModels, ...modelPools],
  };
}

async function loadNodeMetricsHistories(input: {
  ownerUserId: string;
  cliDeviceId: string;
  now: Date;
}) {
  const window7d = overviewWindow("7d", input.now);
  const window24h = overviewWindow("24h", input.now);
  const hourAgo = new Date(input.now.getTime() - OVERVIEW_RANGE_CONFIG["1h"].durationMs);
  try {
    const rows = await prisma.nodeMetricsMinute.findMany({
      where: {
        ownerUserId: input.ownerUserId,
        cliDeviceId: input.cliDeviceId,
        bucketStart: { gte: window7d.start, lt: window7d.end },
      },
      orderBy: { bucketStart: "asc" },
    });
    const list = Array.isArray(rows) ? rows : [];
    return {
      minuteHistory: list.flatMap((row) => {
        const start = row.bucketStart instanceof Date ? row.bucketStart : new Date(row.bucketStart);
        if (start.getTime() < hourAgo.getTime()) return [];
        const point = tryShapeNodeMetricsMinute(row);
        return point ? [point] : [];
      }),
      history24h: shapeNodeMetricsRange(list, window24h),
      history7d: shapeNodeMetricsRange(list, window7d),
    };
  } catch {
    return { minuteHistory: [], history24h: [], history7d: [] };
  }
}

async function removeOwnedRow({
  kind,
  id,
  userId,
  staleBefore,
}: {
  kind: "endpoint" | "discoveredModel";
  id: string;
  userId: string;
  staleBefore?: Date;
}) {
  // Read-only checks first; the transaction repeats them under its fences.
  const precheck =
    kind === "endpoint"
      ? await prisma.endpoint.findUnique({
          where: { id },
          select: { userId: true, lastSeenAt: true },
        })
      : await prisma.discoveredModel.findUnique({
          where: { id },
          select: { userId: true, lastSeenAt: true },
        });
  const label = kind === "endpoint" ? "Endpoint" : "Discovered model";
  if (!precheck || precheck.userId !== userId) {
    throw new ORPCError("NOT_FOUND", { message: `${label} not found.` });
  }
  if (staleBefore && precheck.lastSeenAt && precheck.lastSeenAt >= staleBefore) {
    throw deletionConflict("not_stale", `${label} is not stale.`);
  }
  // A plain delete under the owner fences of every user its cascade writes
  // (fenceParentDelete): the owner fence also serializes it with the device's
  // relay registration, and the rows the cascade reaches are resolved under
  // it (no stale target plan). Request and admission history keeps the
  // deleted ids; the capacity sweeper terminalizes live orphans.
  return runCapacityDeleteTransaction(async (tx) => {
    const orphanCapacityIds = await fenceParentDelete(
      tx,
      kind === "endpoint" ? { userId, endpointIds: [id] } : { userId, discoveredModelIds: [id] },
    );
    if (kind === "endpoint") {
      const row = await tx.endpoint.findUnique({
        where: { id },
        select: { id: true, userId: true, cliDeviceId: true },
      });
      if (!row || row.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "Endpoint not found." });
      }
      const current = await tx.endpoint.findUnique({
        where: { id },
        select: { lastSeenAt: true },
      });
      if (!current) throw new ORPCError("NOT_FOUND", { message: "Endpoint not found." });
      if (staleBefore && current.lastSeenAt && current.lastSeenAt >= staleBefore) {
        throw deletionConflict("not_stale", "Endpoint is not stale.");
      }
      await tx.endpoint.delete({ where: { id } });
      await refreshSharedAutoCapacities(tx, userId, orphanCapacityIds);
      await deleteOrphanAutoCapacities(tx, userId, orphanCapacityIds, { idleOnly: false });
      return { deleted: true };
    }

    const row = await tx.discoveredModel.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!row || row.userId !== userId) {
      throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
    }
    const current = await tx.discoveredModel.findUnique({
      where: { id },
      select: { lastSeenAt: true },
    });
    if (!current) throw new ORPCError("NOT_FOUND", { message: "Discovered model not found." });
    if (staleBefore && current.lastSeenAt && current.lastSeenAt >= staleBefore) {
      throw deletionConflict("not_stale", "Discovered model is not stale.");
    }
    await tx.discoveredModel.delete({ where: { id } });
    await refreshSharedAutoCapacities(tx, userId, orphanCapacityIds);
    await deleteOrphanAutoCapacities(tx, userId, orphanCapacityIds, { idleOnly: false });
    return { deleted: true };
  });
}

export const cliDeviceProcedures = {
  getProfileSlug: protectedProcedure.handler(async ({ context }) => {
    const user = await currentUserSlug(context.session.user.id);
    return { slug: user.slug };
  }),

  previewProfileSlugChange: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) =>
      userSlugChangePreview({ userId: context.session.user.id, nextSlug: input.slug }),
    ),

  updateProfileSlug: protectedProcedure
    .input(z.object({ slug: slugSchema }))
    .handler(async ({ input, context }) => {
      const preview = await userSlugChangePreview({
        userId: context.session.user.id,
        nextSlug: input.slug,
      });
      const updated = await prisma.user.update({
        where: { id: context.session.user.id },
        data: { slug: input.slug },
        select: { id: true, slug: true },
      });
      return { slug: updated.slug, preview };
    }),

  /**
   * Dashboard inventory. Inlines endpoints and models; not an MCP tool.
   * Agents use `listCliDeviceSummaries` and `getCliDevice`.
   */
  listCliDevices: protectedProcedure.handler(async ({ context }) => {
    const rows = await prisma.cliDevice.findMany({
      where: { userId: context.session.user.id },
      orderBy: { createdAt: "desc" },
      select: listCliDevicesSelect,
    });

    const now = new Date();
    const ids = rows.map((row) => row.id);
    const live = await context.services?.getLiveCliFeatures?.(ids);
    const liveTelemetry = context.services?.getLiveNodeTelemetry?.(ids);
    return rows.map((row) =>
      serializeCliDevice(row, now, live?.get(row.id) ?? null, liveTelemetry?.get(row.id) ?? null),
    );
  }),

  /**
   * MCP `forwarder_cli_devices_list`. Summaries only, one page at a time.
   * No `models[]` and no capability JSON.
   */
  listCliDeviceSummaries: protectedProcedure
    .input(summaryPageInput)
    .handler(async ({ input, context }) => {
      const rows = await prisma.cliDevice.findMany({
        where: summaryPageWhere(context.session.user.id, input.cursor),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        select: cliDeviceSummarySelect,
      });
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      const now = new Date();
      const live = await context.services?.getLiveCliFeatures?.(page.map((row) => row.id));
      return {
        items: page.map((row) => serializeCliDeviceSummary(row, now, live?.get(row.id) ?? null)),
        nextCursor:
          rows.length > input.limit && last !== undefined ? encodeSummaryCursor(last) : null,
      };
    }),

  /** MCP `forwarder_cli_device_get`. The full device, including models. */
  getCliDevice: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema }))
    .handler(async ({ input, context }) => {
      const row = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { ...listCliDevicesSelect, userId: true },
      });
      if (!row || row.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      const now = new Date();
      const live = await context.services?.getLiveCliFeatures?.([row.id]);
      const liveTelemetry = context.services?.getLiveNodeTelemetry?.([row.id]);
      return serializeCliDevice(
        row,
        now,
        live?.get(row.id) ?? null,
        liveTelemetry?.get(row.id) ?? null,
      );
    }),

  /**
   * Relay 2.4 node telemetry for one CLI device: its static `node.info`, the
   * freshest `node.metrics` (live from the relay session, else the stored
   * once-a-minute snapshot), live engine load per endpoint, the node-card
   * snapshot (labels, usable budgets, health warnings), last-hour minute
   * history, and 24h/7d sparkline series from the 7-day minutes. Read-only.
   * Label and budget writes are dashboard-only.
   */
  getCliDeviceMetrics: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema }))
    .handler(async ({ input, context }) => {
      const row = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: {
          id: true,
          userId: true,
          slug: true,
          status: true,
          nodeInfo: true,
          nodeInfoAt: true,
          nodeMetrics: true,
          nodeMetricsAt: true,
          labels: true,
          usableMemoryGb: true,
          usableRamGb: true,
          usableVramGb: true,
          mcpCommandMode: true,
          remoteMetricSources: true,
          remoteMetricSourcesAt: true,
          remoteEngineAdapters: true,
          remoteEngineAdaptersAt: true,
        },
      });
      if (!row || row.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      const live = context.services?.getLiveNodeTelemetry?.([row.id]).get(row.id) ?? null;
      const liveMetrics = live?.nodeMetrics ? live : null;
      const now = new Date();
      const series = liveMetrics
        ? deviceMetricSeries(liveMetrics.nodeMetrics, liveMetrics.nodeMetricsReceivedAt, now)
        : deviceMetricSeries(row.nodeMetrics ?? null, row.nodeMetricsAt ?? null, now);
      const nodeMetrics = liveMetrics ? liveMetrics.nodeMetrics : (row.nodeMetrics ?? null);
      return {
        /**
         * Every metric a routing rule can name on this device right now:
         * `node.*` built-ins and custom series (endpoint `endpoint.*` series
         * are per member: see `getPoolRoutingRules`).
         */
        series: describeSeries(series),
        /**
         * Remote metric source definitions the server holds (sent to the CLI
         * only while the device is `unsupervised`); `nodeMetrics.sources`
         * has the CLI's own view of each (active, pending approval, refused).
         */
        remoteMetricSources: serializeRemoteMetricSources(row.remoteMetricSources),
        remoteMetricSourcesAt: row.remoteMetricSourcesAt ?? null,
        remoteMetricSourcesAllowed: row.mcpCommandMode === "UNSUPERVISED",
        remoteEngineAdapters: serializeRemoteEngineAdapters(row.remoteEngineAdapters),
        remoteEngineAdaptersAt: row.remoteEngineAdaptersAt ?? null,
        remoteEngineAdaptersAllowed: row.mcpCommandMode === "UNSUPERVISED",
        cliDeviceId: row.id,
        slug: row.slug,
        live: live !== null,
        nodeInfo: row.nodeInfo ?? null,
        nodeInfoAt: row.nodeInfoAt ?? null,
        nodeMetrics,
        nodeMetricsAt: liveMetrics
          ? liveMetrics.nodeMetricsReceivedAt
          : (row.nodeMetricsAt ?? null),
        nodeMetricsSource: liveMetrics
          ? ("live" as const)
          : row.nodeMetrics
            ? ("stored" as const)
            : null,
        endpointLoad: live?.endpointLoad ?? [],
        labels: normalizeNodeLabels(row.labels ?? []),
        node: serializeCliDeviceNode(row, nodeMetrics),
        ...(await loadNodeMetricsHistories({
          ownerUserId: row.userId,
          cliDeviceId: row.id,
          now,
        })),
      };
    }),

  setCliDeviceFeatureGrants: protectedProcedure
    .input(
      z
        .object({
          cliDeviceId: idSchema,
          humanTerminal: z.boolean().optional(),
          mcpCommandMode: z.enum(MCP_COMMAND_MODES).optional(),
          fileRead: z.boolean().optional(),
        })
        .refine(
          (value) =>
            value.humanTerminal !== undefined ||
            value.mcpCommandMode !== undefined ||
            value.fileRead !== undefined,
          { message: "At least one feature grant is required." },
        ),
    )
    .handler(async ({ input, context }) => {
      const row = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: {
          id: true,
          userId: true,
          reportedHumanTerminal: true,
          reportedMcpCommandMode: true,
          reportedMcpFileRead: true,
          reportedFileRoots: true,
          reportedTerminalSupported: true,
        },
      });
      if (!row || row.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      if (
        input.humanTerminal === true &&
        (row.reportedHumanTerminal !== true || row.reportedTerminalSupported !== true)
      ) {
        throw new ORPCError("BAD_REQUEST", {
          message: "Browser terminal cannot be enabled until this CLI reports support.",
        });
      }
      if (
        input.mcpCommandMode !== undefined &&
        input.mcpCommandMode !== "off" &&
        !mcpCommandModeAtLeast(
          mcpCommandModeFromDb(row.reportedMcpCommandMode ?? null),
          input.mcpCommandMode,
        )
      ) {
        throw new ORPCError("BAD_REQUEST", {
          message: `MCP commands cannot be set to ${input.mcpCommandMode} until this CLI reports that mode (wsmp config set-mcp-commands).`,
        });
      }
      if (
        input.fileRead === true &&
        (row.reportedMcpFileRead !== true || row.reportedFileRoots !== true)
      ) {
        throw new ORPCError("BAD_REQUEST", {
          message: "File reading requires the CLI read switch and configured file roots.",
        });
      }
      const updated = await prisma.cliDevice.update({
        where: { id: row.id },
        data: {
          ...(input.fileRead !== undefined ? { mcpFileRead: input.fileRead } : {}),
          ...(input.humanTerminal !== undefined ? { allowHumanTerminal: input.humanTerminal } : {}),
          ...(input.mcpCommandMode !== undefined
            ? { mcpCommandMode: mcpCommandModeToDb(input.mcpCommandMode) }
            : {}),
        },
        select: { id: true, allowHumanTerminal: true, mcpCommandMode: true, mcpFileRead: true },
      });
      await context.services?.onCliFeatureGrantsChanged?.(updated.id);
      return {
        cliDeviceId: updated.id,
        humanTerminal: updated.allowHumanTerminal,
        fileRead: updated.mcpFileRead,
        mcpCommandMode: mcpCommandModeFromDb(updated.mcpCommandMode),
      };
    }),

  /**
   * Human-only placement labels. Agents read them on the device and metrics
   * tools; selectors are "has all of these" sets.
   */
  setCliDeviceLabels: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema, labels: nodeLabelsSchema }))
    .handler(async ({ input, context }) => {
      const owned = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true },
      });
      if (!owned || owned.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      const labels = normalizeNodeLabels(input.labels);
      const row = await prisma.cliDevice.update({
        where: { id: owned.id },
        data: { labels },
        select: {
          labels: true,
          nodeInfo: true,
          nodeMetrics: true,
          usableMemoryGb: true,
          usableRamGb: true,
          usableVramGb: true,
        },
      });
      const live = context.services?.getLiveNodeTelemetry?.([owned.id]).get(owned.id) ?? null;
      return {
        cliDeviceId: owned.id,
        labels: row.labels,
        node: serializeCliDeviceNode(row, live?.nodeMetrics),
      };
    }),

  /**
   * Human-only usable memory/RAM/VRAM budgets. Null restores the default
   * (node.info total minus a small reserve). Agents read; they never write.
   */
  setCliDeviceUsableBudgets: protectedProcedure
    .input(
      nodeUsableBudgetsInputSchema
        .extend({ cliDeviceId: idSchema })
        .refine(
          (value) =>
            value.usableMemoryGb !== undefined ||
            value.usableRamGb !== undefined ||
            value.usableVramGb !== undefined,
          { message: "At least one usable budget is required." },
        ),
    )
    .handler(async ({ input, context }) => {
      const owned = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true, nodeInfo: true },
      });
      if (!owned || owned.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      const invalid = assertUsableBudgetWrite(parseNodeInfo(owned.nodeInfo), {
        usableMemoryGb: input.usableMemoryGb,
        usableRamGb: input.usableRamGb,
        usableVramGb: input.usableVramGb,
      });
      if (invalid) {
        throw new ORPCError("BAD_REQUEST", {
          message: invalid.message,
          data: { fields: invalid.fields },
        });
      }
      const row = await prisma.cliDevice.update({
        where: { id: owned.id },
        data: {
          ...(input.usableMemoryGb !== undefined ? { usableMemoryGb: input.usableMemoryGb } : {}),
          ...(input.usableRamGb !== undefined ? { usableRamGb: input.usableRamGb } : {}),
          ...(input.usableVramGb !== undefined
            ? {
                usableVramGb: input.usableVramGb === null ? Prisma.DbNull : input.usableVramGb,
              }
            : {}),
        },
        select: {
          labels: true,
          nodeInfo: true,
          nodeMetrics: true,
          usableMemoryGb: true,
          usableRamGb: true,
          usableVramGb: true,
        },
      });
      const live = context.services?.getLiveNodeTelemetry?.([owned.id]).get(owned.id) ?? null;
      return {
        cliDeviceId: owned.id,
        node: serializeCliDeviceNode(row, live?.nodeMetrics),
      };
    }),

  /** Set or clear the user-owned device name. Hello never writes it. */
  renameCliDevice: protectedProcedure
    .input(z.object({ cliDeviceId: idSchema, name: cliDeviceNameSchema }))
    .handler(async ({ input, context }) => {
      const owned = await prisma.cliDevice.findUnique({
        where: { id: input.cliDeviceId },
        select: { id: true, userId: true },
      });
      if (!owned || owned.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "CLI device not found." });
      }
      const row = await prisma.cliDevice.update({
        where: { id: owned.id },
        data: { name: input.name },
        select: { id: true, slug: true, name: true, reportedHostname: true },
      });
      return {
        cliDeviceId: row.id,
        name: row.name,
        displayName: cliDeviceDisplayName(row),
      };
    }),

  removeCliDeviceMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(async ({ input, context }) => {
      // Revokes the device's CLI tokens and deletes its device credentials in
      // the same transaction as the device, then closes their live sessions.
      const { revoked } = await deleteCliDeviceAndCredentials({
        cliDeviceId: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      });
      for (const credentials of revoked) {
        await closeRevokedCliCredentialSessions(context.services, credentials);
      }
      return { deleted: true };
    }),

  removeEndpointMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(({ input, context }) =>
      removeOwnedRow({
        kind: "endpoint",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      }),
    ),

  removeDiscoveredModelMetadata: protectedProcedure
    .input(z.object({ id: idSchema, staleBefore: z.date().optional() }))
    .handler(async ({ input, context }) => {
      // Pool membership cascades away with the model, so capture the affected
      // pools before the delete; the impact itself is computed from the
      // post-delete member state.
      const poolIds = await poolIdsWithMembers(
        prisma,
        context.session.user.id,
        discoveredModelPoolMemberWhere(input.id),
      );
      const removed = await removeOwnedRow({
        kind: "discoveredModel",
        id: input.id,
        userId: context.session.user.id,
        staleBefore: input.staleBefore,
      });
      return {
        ...removed,
        impactedPools: await capabilityEditImpactedPools(prisma, {
          userId: context.session.user.id,
          poolIds,
        }),
      };
    }),
};
