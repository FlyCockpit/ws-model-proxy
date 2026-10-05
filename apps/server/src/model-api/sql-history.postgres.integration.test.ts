import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl)
  throw new Error("PostgreSQL fixture required");

(databaseUrl ? describe : describe.skip)("SQL historical selection identity", () => {
  it("retains exact revoked contribution history while denying every changed authorization identity", async () => {
    if (!databaseUrl) return;
    const fixture = createFixturePrismaClient(databaseUrl);
    // An ordinary production client proves the ownership guard independently
    // of the fixture client's graph-writer fence exemption.
    const strict = createPrismaClient(databaseUrl);
    const suffix = crypto.randomUUID();
    try {
      const owner = await fixture.user.create({
        data: { name: "History pool owner", email: `sql-owner-${suffix}@example.test` },
      });
      const contributor = await fixture.user.create({
        data: { name: "History contributor", email: `sql-contributor-${suffix}@example.test` },
      });
      const stranger = await fixture.user.create({
        data: { name: "History stranger", email: `sql-stranger-${suffix}@example.test` },
      });
      const pool = await fixture.modelPool.create({
        data: { userId: owner.id, name: "Historical", slug: `history-${suffix}` },
      });
      const device = await fixture.cliDevice.create({
        data: { userId: contributor.id, slug: "node" },
      });
      const endpoint = await fixture.endpoint.create({
        data: { userId: contributor.id, cliDeviceId: device.id, slug: "local", label: "Local" },
      });
      const model = await fixture.discoveredModel.create({
        data: {
          userId: contributor.id,
          endpointId: endpoint.id,
          upstreamModelId: "model",
          encodedModelId: "model",
        },
      });
      const target = await fixture.executionTarget.findUniqueOrThrow({
        where: { discoveredModelId: model.id },
      });
      const offer = await fixture.inferenceContribution.create({
        data: {
          contributorUserId: contributor.id,
          poolOwnerUserId: owner.id,
          poolId: pool.id,
          discoveredModelId: model.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await fixture.inferenceContribution.update({
        where: { id: offer.id },
        data: { state: "ACTIVE", acceptedAt: new Date() },
      });
      const member = await fixture.poolMember.create({
        data: { poolId: pool.id, executionTargetId: target.id, inferenceContributionId: offer.id },
      });
      const selected = {
        selectedExecutionTargetId: target.id,
        selectedDiscoveredModelId: model.id,
        selectedPoolMemberId: member.id,
        selectedPoolMemberTier: "PRIMARY",
        fallbackRoute: "local",
      };
      const request = await strict.relayRequest.create({
        data: { userId: owner.id, requestedModelPoolId: pool.id, source: "CHAT_TEST", ...selected },
      });
      const binding = await strict.responseStickinessRecord.create({
        data: {
          userId: owner.id,
          routingKeyDigest: suffix,
          routingVersion: 2,
          targetModelPoolId: pool.id,
          selectedExecutionTargetId: target.id,
          selectedDiscoveredModelId: model.id,
        },
      });
      const attemptId = crypto.randomUUID();
      const admission = await fixture.admissionRequest.create({
        data: {
          userId: owner.id,
          requestId: request.id,
          relayRequestId: request.id,
          attemptId,
          sourceKind: "POOL",
          poolId: pool.id,
          basePriority: 0,
          enqueueSequence: 1n,
          connectionOwner: "sql-history-fixture",
          heartbeatAt: new Date(),
        },
      });
      const lease = await fixture.capacityLease.create({
        data: {
          userId: owner.id,
          admissionRequestId: admission.id,
          requestId: request.id,
          attemptId,
          capacityId: target.inferenceCapacityId ?? "",
          executionTargetId: target.id,
          poolId: pool.id,
          poolMemberId: member.id,
          priority: 0,
          reservationClass: 0,
          fencingToken: 1n,
          ownerServerInstance: "sql-history-fixture",
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      await fixture.capacityLease.update({
        where: { id: lease.id },
        data: { state: "RELEASED", releasedAt: new Date(), releaseReason: "fixture" },
      });
      await strict.relayRequest.update({
        where: { id: request.id },
        data: {
          admissionAttemptId: attemptId,
          admissionLeaseId: lease.id,
          admissionCapacityId: lease.capacityId,
          admissionFencingToken: lease.fencingToken,
        },
      });
      await expect(
        strict.admissionRequest.update({
          where: { id: admission.id },
          data: { relayRequestId: null },
        }),
      ).rejects.toThrow(/historical request identity is immutable/);
      await expect(
        strict.capacityLease.update({ where: { id: lease.id }, data: { fencingToken: 2n } }),
      ).rejects.toThrow(/historical identity is immutable/);
      await fixture.inferenceContribution.update({
        where: { id: offer.id },
        data: { state: "REVOKED", revokedAt: new Date() },
      });
      await fixture.poolMember.delete({ where: { id: member.id } });
      await expect(
        fixture.inferenceContribution.update({
          where: { id: offer.id },
          data: { acceptedAt: new Date(Date.now() + 60_000) },
        }),
      ).rejects.toThrow(/acceptance evidence is immutable/);
      for (const data of [
        { fallbackRoute: "own-key" },
        { userId: stranger.id },
        { source: "API_TOKEN" as const },
        { modelApiTokenId: `foreign-token-${suffix}` },
        { requestedExecutionTargetId: target.id },
        { requestedDiscoveredModelId: model.id },
        { selectedPoolMemberId: `foreign-member-${suffix}` },
        { selectedPoolMemberTier: "PUBLIC_OVERFLOW" },
        { admissionAttemptId: `foreign-attempt-${suffix}` },
        { admissionLeaseId: `foreign-lease-${suffix}` },
        { admissionCapacityId: `foreign-capacity-${suffix}` },
        { admissionFencingToken: 2n },
        { providerModelId: `foreign-provider-${suffix}` },
        { localAttemptId: `foreign-local-${suffix}` },
      ]) {
        await expect(
          strict.relayRequest.update({ where: { id: request.id }, data }),
        ).rejects.toThrow(/relay request (selection|target) must match/);
      }
      await expect(
        strict.relayRequest.update({
          where: { id: request.id },
          data: { status: "FAILED", responseBytes: 11n, errorClass: "revoked" },
        }),
      ).resolves.toMatchObject({ ...selected, status: "FAILED", responseBytes: 11n });
      for (const data of [
        { routingKeyDigest: `foreign-${suffix}` },
        { modelApiTokenId: `foreign-${suffix}` },
        { userId: stranger.id },
        { selectedExecutionTargetId: null, selectedDiscoveredModelId: null },
      ]) {
        await expect(
          strict.responseStickinessRecord.update({ where: { id: binding.id }, data }),
        ).rejects.toThrow(/stickiness/);
      }
      await expect(
        strict.responseStickinessRecord.update({
          where: { id: binding.id },
          data: { expiresAt: new Date(Date.now() + 120_000) },
        }),
      ).resolves.toMatchObject({
        selectedExecutionTargetId: target.id,
        targetModelPoolId: pool.id,
      });
      await expect(
        strict.relayRequest.create({
          data: { userId: owner.id, requestedModelPoolId: pool.id, status: "FAILED", ...selected },
        }),
      ).rejects.toThrow(/selection must match/);
      await expect(
        strict.responseStickinessRecord.create({
          data: {
            userId: owner.id,
            routingKeyDigest: `new-${suffix}`,
            routingVersion: 2,
            targetModelPoolId: pool.id,
            selectedExecutionTargetId: target.id,
          },
        }),
      ).rejects.toThrow(/selection must match/);
      // Persist the accepted/revoked content-free fixture for hardening replay.
      // Parent deletion keeps history; the orphan binding must remain valid on
      // replay, without allowing a fresh binding to a deleted parent.
      await fixture.modelPool.delete({ where: { id: pool.id } });
      await expect(
        strict.responseStickinessRecord.update({
          where: { id: binding.id },
          data: { expiresAt: new Date(Date.now() + 180_000) },
        }),
      ).resolves.toMatchObject({ targetModelPoolId: pool.id });
      await expect(
        strict.relayRequest.update({ where: { id: request.id }, data: { responseBytes: 12n } }),
      ).resolves.toMatchObject({ requestedModelPoolId: pool.id, responseBytes: 12n });
      // The retention sweeper's real FK action may clear the admission's
      // request link only after that exact request has actually disappeared.
      await strict.relayRequest.delete({ where: { id: request.id } });
      expect(
        await strict.admissionRequest.findUniqueOrThrow({ where: { id: admission.id } }),
      ).toMatchObject({
        relayRequestId: null,
      });
    } finally {
      await Promise.all([fixture.$disconnect(), strict.$disconnect()]);
    }
  });
});
