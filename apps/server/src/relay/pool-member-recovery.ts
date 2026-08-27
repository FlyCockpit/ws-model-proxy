import { suggestedConnectionSurface } from "@ws-model-proxy/api/lib/model-connection-type";
import {
  claimPoolMemberRecoveryTrial,
  settlePoolMemberRecoveryTrial,
} from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  openAiCapabilitiesFromCoarse,
  resolveEffectiveCapabilityMetadata,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma, { type Prisma } from "@ws-model-proxy/db";

/**
 * Recovery intentionally lives beside relay sockets rather than in a process-wide
 * database worker.  A websocket is process-local, so only its owning process can
 * safely send a probe (or settle the resulting health observation).
 */
export const POOL_MEMBER_RECOVERY_PROBE_TIMEOUT_MS = 20_000;
export const POOL_MEMBER_RECOVERY_IDLE_POLL_MS = 1_000;

export type OwnedRecoveryMember = {
  id: string;
  cliDeviceId: string;
  endpointSlug: string;
  upstreamModelId: string;
  userId: string;
  capabilities: unknown;
};

type Timer = ReturnType<typeof setTimeout>;

export type PoolMemberRecoverySchedulerDependencies = {
  getOwnedCliDeviceIds(): Iterable<string>;
  listDueMembers(cliDeviceIds: string[], now: Date): Promise<OwnedRecoveryMember[]>;
  probe(member: OwnedRecoveryMember): Promise<boolean>;
  now?(): Date;
  setTimer?(callback: () => void, ms: number): Timer;
  clearTimer?(timer: Timer): void;
  idlePollMs?: number;
  claim?(memberId: string, now: Date): Promise<Date | null>;
  settle?(input: {
    memberId: string;
    trialStartedAt: Date;
    healthy: boolean;
    now: Date;
  }): Promise<boolean>;
};

export class PoolMemberRecoveryScheduler {
  private timer: Timer | null = null;
  private running = false;
  private stopped = false;
  private wakeRequested = false;
  private readonly now: () => Date;
  private readonly setTimer: (callback: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;

  constructor(private readonly dependencies: PoolMemberRecoverySchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /** Start or promptly rescan after a local relay session is registered. */
  wake() {
    if (this.stopped) return;
    if (![...this.dependencies.getOwnedCliDeviceIds()].length) {
      if (this.timer) this.clearTimer(this.timer);
      this.timer = null;
      return;
    }
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number) {
    if (this.stopped || this.timer || this.running) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  private async run() {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const ownedIds = [...new Set(this.dependencies.getOwnedCliDeviceIds())];
      if (ownedIds.length > 0) {
        const members = await this.dependencies.listDueMembers(ownedIds, this.now());
        for (const member of members) {
          // A session can be replaced/disconnected after the DB query. Never
          // probe or write health for a member once we no longer own its socket.
          if (!new Set(this.dependencies.getOwnedCliDeviceIds()).has(member.cliDeviceId)) continue;
          // Do not turn an intentionally non-chat model (embeddings, image,
          // audio, or unknown inventory) into a transport failure merely
          // because we cannot construct a safe health request for it.
          if (!suggestedConnectionSurface({ capabilities: member.capabilities as never })) continue;
          const trialStartedAt = await (
            this.dependencies.claim ??
            ((id, now) => claimPoolMemberRecoveryTrial({ poolMemberId: id, now }))
          )(member.id, this.now());
          if (!trialStartedAt) continue;
          const healthy = await this.dependencies.probe(member).catch(() => false);
          if (!new Set(this.dependencies.getOwnedCliDeviceIds()).has(member.cliDeviceId)) continue;
          await (
            this.dependencies.settle ??
            ((input) =>
              settlePoolMemberRecoveryTrial({
                poolMemberId: input.memberId,
                trialStartedAt: input.trialStartedAt,
                healthy: input.healthy,
                now: input.now,
              }))
          )({ memberId: member.id, trialStartedAt, healthy, now: this.now() });
        }
      }
    } catch {
      // A transient database failure must not turn a relay registration into an
      // unhandled rejection. The next bounded tick will retry the scan.
    } finally {
      this.running = false;
      if (this.stopped) {
        // stop() has already cancelled the pending timer.
      } else if (![...this.dependencies.getOwnedCliDeviceIds()].length) {
        this.wakeRequested = false;
      } else if (this.wakeRequested) {
        this.wakeRequested = false;
        this.schedule(0);
      } else {
        this.schedule(this.dependencies.idlePollMs ?? POOL_MEMBER_RECOVERY_IDLE_POLL_MS);
      }
    }
  }
}

/** DB selection is deliberately constrained to locally-relayed, active members.
 * Provider targets have no discovered-model endpoint and therefore cannot match. */
export async function listDueOwnedPoolMemberRecoveries(
  cliDeviceIds: string[],
  now: Date,
): Promise<OwnedRecoveryMember[]> {
  if (cliDeviceIds.length === 0) return [];
  const endpointWhere: Prisma.EndpointWhereInput = {
    cliDeviceId: { in: cliDeviceIds },
    published: true,
    status: { not: "OFFLINE" },
    CliDevice: { status: "CONNECTED" as const },
  };
  const rows = await prisma.poolMember.findMany({
    where: {
      routingStatus: "ACTIVE",
      weight: { gt: 0 },
      healthStatus: { in: ["DEGRADED", "UNHEALTHY"] },
      nextRetryAt: { lte: now },
      OR: [
        { executionTargetId: null, DiscoveredModel: { published: true, Endpoint: endpointWhere } },
        {
          executionTargetId: { not: null },
          ExecutionTarget: { DiscoveredModel: { published: true, Endpoint: endpointWhere } },
        },
      ],
    },
    select: {
      id: true,
      ModelPool: { select: { userId: true } },
      DiscoveredModel: {
        select: {
          upstreamModelId: true,
          capabilityOverrideMode: true,
          capabilityOverrides: true,
          capabilityOverrideMetadata: true,
          Endpoint: {
            select: {
              slug: true,
              cliDeviceId: true,
              defaultCapabilities: true,
              capabilityMetadata: true,
            },
          },
        },
      },
      ExecutionTarget: {
        select: {
          DiscoveredModel: {
            select: {
              upstreamModelId: true,
              capabilityOverrideMode: true,
              capabilityOverrides: true,
              capabilityOverrideMetadata: true,
              Endpoint: {
                select: {
                  slug: true,
                  cliDeviceId: true,
                  defaultCapabilities: true,
                  capabilityMetadata: true,
                },
              },
            },
          },
        },
      },
    },
  });
  return (rows ?? []).flatMap((row) => {
    const model = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
    if (!model) return [];
    return [
      {
        id: row.id,
        cliDeviceId: model.Endpoint.cliDeviceId,
        endpointSlug: model.Endpoint.slug,
        upstreamModelId: model.upstreamModelId,
        userId: row.ModelPool.userId,
        capabilities:
          resolveEffectiveCapabilityMetadata({
            capabilityOverrideMode: model.capabilityOverrideMode,
            capabilityOverrideMetadata: model.capabilityOverrideMetadata,
            endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
          }) ??
          openAiCapabilitiesFromCoarse(
            model.capabilityOverrideMode === "OVERRIDE"
              ? model.capabilityOverrides
              : model.Endpoint.defaultCapabilities,
          ),
      },
    ];
  });
}
