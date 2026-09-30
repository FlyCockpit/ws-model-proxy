-- Database invariants and compatibility backfills that Prisma cannot express.
-- This file is idempotent and is applied by the repository db:push wrappers.

BEGIN;

-- DL-1 deploy lock order: this transaction takes EVERY table it touches in
-- one statement, up front, in the strongest mode any later statement needs
-- (ACCESS EXCLUSIVE: ALTER TABLE / DROP TRIGGER), with NOWAIT. It therefore
-- never waits on a lock while holding one, so it cannot be part of a lock
-- cycle with live capacity work (admission, lease release, relay writers);
-- when any table is busy the statement fails at once with 55P03 and
-- apply-schema-hardening.mjs retries the whole transaction with backoff. No
-- later statement upgrades a lock. "Touches" is over-approximated: every
-- repository table named anywhere below, including tables only read by
-- backfills or by trigger/function bodies (backfill writes fire those
-- triggers). verify-schema-hardening.mjs fails when a table named in this
-- file is missing from this list. An insert that committed before these
-- locks is included by the backfills below; one that starts after they are
-- released sees the installed triggers.
LOCK TABLE "user", cli_device, endpoint, discovered_model, execution_target, model_pool,
  model_api_token, pool_member, pool_grant, pool_fallback_preference,
  model_api_token_allowlist_entry, response_stickiness_record,
  relay_request, inference_capacity, capacity_runtime, admission_request, capacity_waiter,
  capacity_lease, capacity_audit_event, provider_account, provider_model, provider_credential,
  provider_budget_policy, provider_budget_rule, provider_attempt, provider_budget_reservation,
  provider_usage_ledger, provider_pricing_version, provider_budget_settlement,
  provider_audit_event, public_provider_attempt_event, relay_execution_attempt,
  relay_execution_event, usage_rollup_minute, usage_rollup_hour,
  cache_affinity_record, session IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Deploy writer (class D): the backfills below rewrite graph rows while every
-- table is locked exclusively, so no fence can be contended. The graph-write
-- fence triggers (installed further down) accept any write while this
-- transaction-local marker is set; only this file and test fixtures set it.
SELECT set_config('wsmp.fences', ',*,', true);

-- Not a table: taken after the lock so the LOCK is the first statement.
CREATE SEQUENCE IF NOT EXISTS admission_enqueue_sequence AS bigint MINVALUE 0 START 1;

-- Capacity policy bounds are database invariants because admission correctness
-- must not depend on every rolling-deploy writer running the same validator.
-- Prisma adds the discriminator columns with INHERIT defaults. Preserve legacy
-- finite member overrides by tagging every existing non-null value as LIMITED.
UPDATE pool_member
   SET "capacityConcurrencyMode" = 'LIMITED'
 WHERE "capacityConcurrencyLimit" IS NOT NULL
   AND "capacityConcurrencyMode" = 'INHERIT';

UPDATE pool_member
   SET "capacityWaitBudgetMode" = 'LIMITED'
 WHERE "capacityWaitBudgetMs" IS NOT NULL
   AND "capacityWaitBudgetMode" = 'INHERIT';

UPDATE pool_member
   SET "capacityContextCeilingMode" = 'LIMITED'
 WHERE "capacityContextCeiling" IS NOT NULL
   AND "capacityContextCeilingMode" = 'INHERIT';

UPDATE capacity_waiter waiter
   SET "requestId" = request."requestId",
       "attemptId" = request."attemptId",
       "enqueueSequence" = request."enqueueSequence"
  FROM admission_request request
 WHERE request.id = waiter."admissionRequestId"
   AND (waiter."requestId" IS DISTINCT FROM request."requestId"
     OR waiter."attemptId" IS DISTINCT FROM request."attemptId"
     OR waiter."enqueueSequence" IS DISTINCT FROM request."enqueueSequence");

UPDATE capacity_waiter
   SET "effectiveConcurrencyScope" = 'DIRECT_TARGET',
       "effectiveConcurrencyScopeId" = "executionTargetId"
 WHERE "effectiveConcurrencyScope" = '' AND "poolMemberId" IS NULL;

UPDATE capacity_waiter waiter
   SET "effectiveConcurrencyScope" = CASE
         WHEN member."capacityConcurrencyMode" = 'INHERIT' THEN 'POOL' ELSE 'MEMBER' END,
       "effectiveConcurrencyScopeId" = CASE
         WHEN member."capacityConcurrencyMode" = 'INHERIT' THEN waiter."poolId" ELSE waiter."poolMemberId" END
  FROM pool_member member
 WHERE waiter."effectiveConcurrencyScope" = ''
   AND member.id = waiter."poolMemberId";

ALTER TABLE inference_capacity DROP CONSTRAINT IF EXISTS inference_capacity_limits_check;
ALTER TABLE inference_capacity ADD CONSTRAINT inference_capacity_limits_check CHECK (
  ("hardConcurrencyLimit" IS NULL OR "hardConcurrencyLimit" > 0)
  AND ("physicalMaxContext" IS NULL OR "physicalMaxContext" > 0)
);

ALTER TABLE capacity_runtime DROP CONSTRAINT IF EXISTS capacity_runtime_scheduler_check;
ALTER TABLE capacity_runtime ADD CONSTRAINT capacity_runtime_scheduler_check CHECK (
  "schedulerCursor" BETWEEN 0 AND 31
  AND "schedulerVersion" > 0
  AND "nextFencingToken" > 0
  AND ((jsonb_typeof("schedulerDeficits") = 'array' AND jsonb_array_length("schedulerDeficits") = 32)
    OR "schedulerDeficits" = '{}'::jsonb)
);

-- DL-1 design (d) (#78): the scheduler state moved from inference_capacity to
-- capacity_runtime. The dangerous schema push dropped the old columns, so the
-- fairness cursor and deficits restart; the fencing token must not. A
-- capacity's next token starts above every lease token it ever issued
-- (capacity_lease keeps (capacityId, fencingToken) unique), whether or not
-- the capacity row still exists. Idempotent: it only ever raises a counter.
-- The admission store creates a missing row the same way on first use.
INSERT INTO capacity_runtime ("capacityId", "userId", "nextFencingToken")
SELECT lease."capacityId", MIN(lease."userId"), MAX(lease."fencingToken") + 1
  FROM capacity_lease lease
 GROUP BY lease."capacityId"
ON CONFLICT ("capacityId") DO UPDATE
   SET "nextFencingToken" = GREATEST(capacity_runtime."nextFencingToken", EXCLUDED."nextFencingToken");

ALTER TABLE execution_target DROP CONSTRAINT IF EXISTS execution_target_capacity_policy_check;
ALTER TABLE execution_target ADD CONSTRAINT execution_target_capacity_policy_check CHECK (
  "directPriority" BETWEEN 0 AND 31
  AND ("directConcurrencyLimit" IS NULL OR "directConcurrencyLimit" > 0)
  AND "directReservedSlots" >= 0
  AND ("directWaitBudgetMs" IS NULL OR "directWaitBudgetMs" >= 0)
  AND ("directContextCeiling" IS NULL OR "directContextCeiling" > 0)
  AND "directContextMargin" >= 0
  AND ("directContextCeiling" IS NULL OR "directContextMargin" < "directContextCeiling")
);

ALTER TABLE model_pool DROP CONSTRAINT IF EXISTS model_pool_capacity_policy_check;
ALTER TABLE model_pool ADD CONSTRAINT model_pool_capacity_policy_check CHECK (
  "capacityPriority" BETWEEN 0 AND 31
  AND ("capacityConcurrencyLimit" IS NULL OR "capacityConcurrencyLimit" > 0)
  AND "capacityReservedSlots" >= 0
  AND ("capacityWaitBudgetMs" IS NULL OR "capacityWaitBudgetMs" >= 0)
  AND ("capacityContextCeiling" IS NULL OR "capacityContextCeiling" > 0)
  AND "capacityContextMargin" >= 0
  AND ("capacityContextCeiling" IS NULL OR "capacityContextMargin" < "capacityContextCeiling")
);

ALTER TABLE model_pool DROP CONSTRAINT IF EXISTS model_pool_affinity_policy_check;
ALTER TABLE model_pool ADD CONSTRAINT model_pool_affinity_policy_check CHECK (
  "affinityTtlSeconds" BETWEEN 60 AND 604800
  AND "affinityMaxRecords" BETWEEN 100 AND 100000
  AND "affinityPrefixWeight" BETWEEN 0 AND 10000
  AND "affinityConversationWeight" BETWEEN 0 AND 10000
  AND "affinityConfirmedCacheWeight" BETWEEN 0 AND 10000
  AND "affinityLoadPenaltyWeight" BETWEEN 0 AND 10000
);

-- Affinity is disposable prediction state. Version 3 separates stable explicit
-- conversation identity from exact cache-prefix bindings. Older predictions
-- cannot be safely reinterpreted and are discarded.
DELETE FROM cache_affinity_record
 WHERE "digestVersion" < 3 OR "tenantUserId" IS NULL;
ALTER TABLE cache_affinity_record ALTER COLUMN "tenantUserId" SET NOT NULL;
ALTER TABLE cache_affinity_record ADD COLUMN IF NOT EXISTS "bindingDigest" TEXT;
DELETE FROM cache_affinity_record WHERE "bindingDigest" IS NULL; -- policy: bounded-delete
ALTER TABLE cache_affinity_record ALTER COLUMN "bindingDigest" SET NOT NULL;
ALTER TABLE cache_affinity_record ALTER COLUMN "prefixDigest" DROP NOT NULL;
ALTER TABLE cache_affinity_record ALTER COLUMN "conversationDigest" DROP NOT NULL;
ALTER TABLE cache_affinity_record ALTER COLUMN "digestVersion" SET DEFAULT 4;

CREATE UNIQUE INDEX IF NOT EXISTS cache_affinity_conversation_unique
  ON cache_affinity_record
    ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest")
  WHERE "conversationDigest" IS NOT NULL AND "prefixDigest" IS NULL;

ALTER TABLE cache_affinity_record DROP CONSTRAINT IF EXISTS cache_affinity_record_shape_check;
ALTER TABLE cache_affinity_record ADD CONSTRAINT cache_affinity_record_shape_check CHECK (
  "digestVersion" >= 3
  AND "prefixDepth" >= 0 AND "prefixDepth" <= 64
  AND ("estimatedTokens" IS NULL OR "estimatedTokens" >= 0)
  AND "expiresAt" > "createdAt"
  AND length("bindingDigest") BETWEEN 32 AND 128
  AND (("prefixDigest" IS NOT NULL AND "prefixDepth" > 0
        AND "conversationDigest" IS NULL
        AND length("prefixDigest") BETWEEN 32 AND 128)
    OR ("prefixDigest" IS NULL AND "prefixDepth" = 0
        AND "conversationDigest" IS NOT NULL
        AND length("conversationDigest") BETWEEN 32 AND 128))
  AND length("targetIdentity") BETWEEN 1 AND 2048
);

CREATE OR REPLACE FUNCTION enforce_cache_affinity_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $cache_affinity_identity_immutable$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."tenantUserId" IS DISTINCT FROM OLD."tenantUserId"
    OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
    OR NEW."executionTargetId" IS DISTINCT FROM OLD."executionTargetId"
    OR NEW."targetIdentity" IS DISTINCT FROM OLD."targetIdentity"
    OR NEW."digestVersion" IS DISTINCT FROM OLD."digestVersion"
    OR NEW."bindingDigest" IS DISTINCT FROM OLD."bindingDigest"
    OR NEW."prefixDigest" IS DISTINCT FROM OLD."prefixDigest"
    OR NEW."conversationDigest" IS DISTINCT FROM OLD."conversationDigest"
    OR NEW."prefixDepth" IS DISTINCT FROM OLD."prefixDepth" THEN
    RAISE EXCEPTION 'cache affinity identity and HMAC digests are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cache_affinity_identity_immutable$;

DROP TRIGGER IF EXISTS cache_affinity_identity_immutable ON cache_affinity_record;
CREATE TRIGGER cache_affinity_identity_immutable
BEFORE UPDATE ON cache_affinity_record
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_identity_immutable();

-- DL-1 (d): cache affinity is hot-path history without foreign keys to the
-- graph. What the (poolId, userId) and (executionTargetId, userId) foreign
-- keys enforced is kept here with plain reads: a record's pool and target
-- belong to its owner. A parent that no longer exists is tolerated (a
-- concurrent delete; the record is orphaned history, removed at expiry or by
-- the pool's clear); a parent of another owner is refused.
CREATE OR REPLACE FUNCTION enforce_cache_affinity_owner()
RETURNS trigger LANGUAGE plpgsql AS $cache_affinity_owner$
DECLARE
  parent_owner TEXT;
BEGIN
  SELECT "userId" INTO parent_owner FROM model_pool WHERE id = NEW."poolId";
  IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION 'cache affinity pool must belong to its owner' USING ERRCODE = '23514';
  END IF;
  SELECT "userId" INTO parent_owner FROM execution_target WHERE id = NEW."executionTargetId";
  IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION 'cache affinity target must belong to its owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cache_affinity_owner$;

DROP TRIGGER IF EXISTS cache_affinity_owner ON cache_affinity_record;
CREATE TRIGGER cache_affinity_owner
BEFORE INSERT ON cache_affinity_record
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_owner();

ALTER TABLE pool_member DROP CONSTRAINT IF EXISTS pool_member_capacity_policy_check;
ALTER TABLE pool_member ADD CONSTRAINT pool_member_capacity_policy_check CHECK (
  ("capacityPriority" IS NULL OR "capacityPriority" BETWEEN 0 AND 31)
  AND (("capacityConcurrencyMode" = 'LIMITED' AND "capacityConcurrencyLimit" > 0)
    OR ("capacityConcurrencyMode" IN ('INHERIT', 'UNLIMITED') AND "capacityConcurrencyLimit" IS NULL))
  AND ("capacityReservedSlots" IS NULL OR "capacityReservedSlots" >= 0)
  AND (("capacityWaitBudgetMode" = 'LIMITED' AND "capacityWaitBudgetMs" > 0)
    OR ("capacityWaitBudgetMode" IN ('INHERIT', 'UNLIMITED') AND "capacityWaitBudgetMs" IS NULL))
  AND (("capacityContextCeilingMode" = 'LIMITED' AND "capacityContextCeiling" > 0)
    OR ("capacityContextCeilingMode" IN ('INHERIT', 'UNLIMITED') AND "capacityContextCeiling" IS NULL))
  AND ("capacityContextMargin" IS NULL OR "capacityContextMargin" >= 0)
  AND ("capacityContextCeilingMode" <> 'LIMITED' OR "capacityContextMargin" IS NULL
    OR "capacityContextMargin" < "capacityContextCeiling")
);

ALTER TABLE pool_member DROP CONSTRAINT IF EXISTS pool_member_tier_shape_check;
ALTER TABLE pool_member ADD CONSTRAINT pool_member_tier_shape_check CHECK (
  (tier = 'PRIMARY' AND "publicOrder" IS NULL)
  OR (tier = 'PUBLIC_OVERFLOW' AND "publicOrder" IS NOT NULL AND "publicOrder" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS pool_member_public_order_unique
  ON pool_member ("poolId", "publicOrder") WHERE tier = 'PUBLIC_OVERFLOW';

-- Fallback redesign: a pool's plain name never leaves the deployment.
-- PRIMARY members are always local (discovered) models; provider models can
-- only be PUBLIC_OVERFLOW (external fallback) members, which the runtime uses
-- only for `owner/pool:external` requests with caller, token, and owner
-- consent. The owner's fallback switch ("publicEgressEnabled", Prisma
-- `fallbackEnabled`) is a runtime gate, not a membership precondition, so the
-- owner can turn fallback off without deleting configured members.
CREATE OR REPLACE FUNCTION enforce_pool_member_tier_source()
RETURNS trigger LANGUAGE plpgsql AS $pool_member_tier_source$
DECLARE
  target_kind "ExecutionTargetKind";
  target_owner TEXT;
  pool_owner TEXT;
BEGIN
  SELECT kind, "userId" INTO target_kind, target_owner
    FROM execution_target WHERE id = NEW."executionTargetId";
  SELECT "userId" INTO pool_owner
    FROM model_pool WHERE id = NEW."poolId";
  IF target_owner IS DISTINCT FROM pool_owner THEN
    RAISE EXCEPTION 'pool member target must have the same owner as its pool'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tier = 'PRIMARY' AND target_kind IS DISTINCT FROM 'DISCOVERED_MODEL' THEN
    RAISE EXCEPTION 'primary pool members must be local discovered models; provider models belong to the external fallback tier'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.tier = 'PUBLIC_OVERFLOW' AND target_kind IS DISTINCT FROM 'PROVIDER_MODEL' THEN
    RAISE EXCEPTION 'external fallback pool members must be provider models'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$pool_member_tier_source$;

DROP TRIGGER IF EXISTS pool_member_tier_source ON pool_member;
CREATE TRIGGER pool_member_tier_source
BEFORE INSERT OR UPDATE OF "poolId", "executionTargetId", tier, "publicOrder" ON pool_member
FOR EACH ROW EXECUTE FUNCTION enforce_pool_member_tier_source();

-- The former "remove members before disabling / revoking acknowledgement"
-- rules are gone: disabling fallback keeps members configured and the runtime
-- stops using them.
DROP TRIGGER IF EXISTS model_pool_public_disable ON model_pool;
DROP FUNCTION IF EXISTS enforce_pool_public_disable();

-- Fallback redesign data step (idempotent; a no-op once applied). Provider
-- PRIMARY members move to the external fallback tier, in this order:
--   1. enable fallback on affected pools (callers must still opt in per
--      request with `:external`, so this is less egress than before);
--   2. assign each moved member a publicOrder after the pool's existing
--      fallback members, unique per pool (weight desc, id);
--   3. switch the tier in the same statement, so the tier shape check and the
--      unique fallback order index hold for every row.
UPDATE model_pool pool
   SET "publicEgressEnabled" = TRUE
 WHERE NOT pool."publicEgressEnabled"
   AND EXISTS (
     SELECT 1
       FROM pool_member member
       JOIN execution_target target ON target.id = member."executionTargetId"
      WHERE member."poolId" = pool.id
        AND member.tier = 'PRIMARY'
        AND target.kind = 'PROVIDER_MODEL'
   );

WITH provider_primary AS (
  SELECT member.id,
         member."poolId",
         row_number() OVER (
           PARTITION BY member."poolId" ORDER BY member.weight DESC, member.id
         ) AS position
    FROM pool_member member
    JOIN execution_target target ON target.id = member."executionTargetId"
   WHERE member.tier = 'PRIMARY'
     AND target.kind = 'PROVIDER_MODEL'
), next_public_order AS (
  SELECT provider_primary."poolId",
         COALESCE((
           SELECT MAX(existing."publicOrder") + 1
             FROM pool_member existing
            WHERE existing."poolId" = provider_primary."poolId"
              AND existing.tier = 'PUBLIC_OVERFLOW'
         ), 0) AS base
    FROM provider_primary
   GROUP BY provider_primary."poolId"
)
UPDATE pool_member member
   SET tier = 'PUBLIC_OVERFLOW',
       "publicOrder" = next_public_order.base + provider_primary.position - 1,
       weight = 0
  FROM provider_primary
  JOIN next_public_order ON next_public_order."poolId" = provider_primary."poolId"
 WHERE member.id = provider_primary.id;

CREATE OR REPLACE FUNCTION enforce_model_pool_owner_immutable()
RETURNS trigger LANGUAGE plpgsql AS $model_pool_owner_immutable$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'model pool owner is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$model_pool_owner_immutable$;

DROP TRIGGER IF EXISTS model_pool_owner_immutable ON model_pool;
CREATE TRIGGER model_pool_owner_immutable
BEFORE UPDATE OF "userId" ON model_pool
FOR EACH ROW EXECUTE FUNCTION enforce_model_pool_owner_immutable();

ALTER TABLE admission_request DROP CONSTRAINT IF EXISTS admission_request_shape_check;
ALTER TABLE admission_request ADD CONSTRAINT admission_request_shape_check CHECK (
  "basePriority" BETWEEN 0 AND 31
  AND "enqueueSequence" >= 0
  AND (("sourceKind" = 'DIRECT' AND "poolId" IS NULL
        AND "directExecutionTargetId" IS NOT NULL)
    OR ("sourceKind" = 'POOL' AND "poolId" IS NOT NULL
        AND "directExecutionTargetId" IS NULL))
  AND ("deadlineAt" IS NULL OR "deadlineAt" >= "enqueuedAt")
  AND ((state IN ('CANCELLED', 'EXPIRED', 'TERMINAL') AND "terminalAt" IS NOT NULL)
    OR (state IN ('WAITING', 'ADMITTED') AND "terminalAt" IS NULL))
);

ALTER TABLE capacity_waiter DROP CONSTRAINT IF EXISTS capacity_waiter_shape_check;
ALTER TABLE capacity_waiter ADD CONSTRAINT capacity_waiter_shape_check CHECK (
  "candidateOrder" >= 0
  AND "requestId" <> ''
  AND "attemptId" <> ''
  AND "enqueueSequence" >= 0
  AND "effectivePriority" BETWEEN 0 AND 31
  AND ("effectiveConcurrencyLimit" IS NULL OR "effectiveConcurrencyLimit" > 0)
  AND "effectiveConcurrencyScope" IN ('DIRECT_TARGET', 'POOL', 'MEMBER')
  AND "effectiveConcurrencyScopeId" <> ''
  AND "effectiveReservedSlots" >= 0
  -- Saturation S-A: a deferred waiter's deadline never precedes its notBefore.
  AND ("notBefore" IS NULL OR "deadlineAt" IS NULL OR "deadlineAt" >= "notBefore")
  AND (("poolId" IS NULL AND "poolMemberId" IS NULL)
    OR ("poolId" IS NOT NULL AND "poolMemberId" IS NOT NULL))
);

ALTER TABLE capacity_lease DROP CONSTRAINT IF EXISTS capacity_lease_shape_check;
ALTER TABLE capacity_lease ADD CONSTRAINT capacity_lease_shape_check CHECK (
  priority BETWEEN 0 AND 31
  AND "reservationClass" BETWEEN 0 AND 31
  AND "fencingToken" > 0
  AND "expiresAt" > "acquiredAt"
  AND (("poolId" IS NULL AND "poolMemberId" IS NULL)
    OR ("poolId" IS NOT NULL AND "poolMemberId" IS NOT NULL))
  AND ((state = 'ACTIVE' AND "releasedAt" IS NULL)
    OR (state <> 'ACTIVE' AND "releasedAt" IS NOT NULL))
);

ALTER TABLE response_stickiness_record
  DROP CONSTRAINT IF EXISTS response_stickiness_routing_version_check;
ALTER TABLE response_stickiness_record
  ADD CONSTRAINT response_stickiness_routing_version_check CHECK ("routingVersion" >= 1);

-- Provider-backed Responses bindings are complete immutable snapshots. Older
-- rows remain readable during rolling deployment and are not reinterpreted.
ALTER TABLE response_stickiness_record
  DROP CONSTRAINT IF EXISTS response_stickiness_provider_binding_check;
ALTER TABLE response_stickiness_record
  ADD CONSTRAINT response_stickiness_provider_binding_check CHECK (
    ("routingVersion" < 3 AND "providerAccountId" IS NULL AND "providerModelId" IS NULL
      AND "providerEndpointIdentity" IS NULL AND "providerEndpointVersion" IS NULL
      AND "providerUpstreamModelId" IS NULL AND "nativeSurface" IS NULL
      AND "upstreamResponseIdDigest" IS NULL
      -- Local (v2) grantee bindings carry their exact pool grant.
      AND ("poolGrantId" IS NULL OR "targetModelPoolId" IS NOT NULL))
    OR
    ("routingVersion" >= 3 AND "providerAccountId" IS NOT NULL AND "providerModelId" IS NOT NULL
      AND "selectedExecutionTargetId" IS NOT NULL AND "targetModelPoolId" IS NOT NULL
      AND "targetDiscoveredModelId" IS NULL AND "targetExecutionTargetId" IS NULL
      AND "selectedDiscoveredModelId" IS NULL
      AND "providerEndpointIdentity" IS NOT NULL AND length("providerEndpointIdentity") > 0
      AND "providerEndpointVersion" IS NOT NULL AND "providerEndpointVersion" > 0
      AND "providerUpstreamModelId" IS NOT NULL AND length("providerUpstreamModelId") > 0
      AND "nativeSurface" = 'OPENAI_RESPONSES'
      AND "upstreamResponseIdDigest" IS NOT NULL
      AND length("upstreamResponseIdDigest") BETWEEN 32 AND 128)
  );

-- A prior release may already have this trigger installed. Remove it before
-- replacing its function or performing the one-time grant-identity backfill.
-- The enclosing transaction holds a table lock and restores the old trigger
-- on rollback, so no writer can observe an unenforced compatibility window.
DROP TRIGGER IF EXISTS response_stickiness_provider_binding_immutable
  ON response_stickiness_record;

CREATE OR REPLACE FUNCTION enforce_response_stickiness_provider_binding_immutable()
RETURNS trigger LANGUAGE plpgsql AS $response_stickiness_provider_binding_immutable$
BEGIN
  IF NEW."routingVersion" >= 3 AND (
    OLD."routingVersion" < 3
    OR NEW."routingVersion" IS DISTINCT FROM OLD."routingVersion"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."modelApiTokenId" IS DISTINCT FROM OLD."modelApiTokenId"
    OR NEW."routingKeyDigest" IS DISTINCT FROM OLD."routingKeyDigest"
    OR NEW."targetDiscoveredModelId" IS DISTINCT FROM OLD."targetDiscoveredModelId"
    OR NEW."targetExecutionTargetId" IS DISTINCT FROM OLD."targetExecutionTargetId"
    OR NEW."targetModelPoolId" IS DISTINCT FROM OLD."targetModelPoolId"
    OR NEW."selectedDiscoveredModelId" IS DISTINCT FROM OLD."selectedDiscoveredModelId"
    OR NEW."selectedExecutionTargetId" IS DISTINCT FROM OLD."selectedExecutionTargetId"
    OR NEW."poolGrantId" IS DISTINCT FROM OLD."poolGrantId"
    OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
    OR NEW."providerModelId" IS DISTINCT FROM OLD."providerModelId"
    OR NEW."providerEndpointIdentity" IS DISTINCT FROM OLD."providerEndpointIdentity"
    OR NEW."providerEndpointVersion" IS DISTINCT FROM OLD."providerEndpointVersion"
    OR NEW."providerUpstreamModelId" IS DISTINCT FROM OLD."providerUpstreamModelId"
    OR NEW."nativeSurface" IS DISTINCT FROM OLD."nativeSurface"
    OR NEW."upstreamResponseIdDigest" IS DISTINCT FROM OLD."upstreamResponseIdDigest"
    OR NEW."fallbackRoute" IS DISTINCT FROM OLD."fallbackRoute"
  ) THEN
    RAISE EXCEPTION 'provider Responses binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$response_stickiness_provider_binding_immutable$;

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_admission_telemetry_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_admission_telemetry_check CHECK (
  ("admissionWaitDurationMs" IS NULL OR "admissionWaitDurationMs" >= 0)
  AND ("admissionReservationClass" IS NULL OR "admissionReservationClass" BETWEEN 0 AND 31)
  AND ("admissionFencingToken" IS NULL OR "admissionFencingToken" > 0)
);

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_execution_telemetry_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_execution_telemetry_check CHECK (
  ("requestedSurface" IS NULL OR "requestedSurface" IN (
    'OPENAI_CHAT_COMPLETIONS', 'OPENAI_COMPLETIONS', 'OPENAI_EMBEDDINGS',
    'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES', 'OPENAI_AUDIO'
  ))
  AND ("selectedNativeSurface" IS NULL OR "selectedNativeSurface" IN (
    'OPENAI_CHAT_COMPLETIONS', 'OPENAI_COMPLETIONS', 'OPENAI_EMBEDDINGS',
    'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES', 'OPENAI_AUDIO'
  ))
  AND ("adapterMode" IS NULL OR "adapterMode" IN ('NATIVE', 'ADAPTED'))
  AND ("adapterVersion" IS NULL OR ("adapterMode" = 'ADAPTED' AND length("adapterVersion") <= 32))
  AND ("localAttemptId" IS NULL OR length("localAttemptId") BETWEEN 1 AND 128)
  AND ("firstClientByteAt" IS NULL OR "streamCommitted")
);

ALTER TABLE relay_execution_event DROP CONSTRAINT IF EXISTS relay_execution_event_shape_check;
ALTER TABLE relay_execution_event ADD CONSTRAINT relay_execution_event_shape_check CHECK (
  "eventType" IN ('ATTEMPT_STARTED', 'FIRST_CLIENT_BYTE', 'TERMINAL', 'CRASH_RECOVERED')
  AND "attemptKind" IN ('EXECUTION', 'CONTEXT_COUNT')
  AND "requestedSurface" IN (
    'OPENAI_CHAT_COMPLETIONS', 'OPENAI_COMPLETIONS', 'OPENAI_EMBEDDINGS',
    'OPENAI_RESPONSES', 'ANTHROPIC_MESSAGES', 'OPENAI_AUDIO'
  )
  AND ("adapterMode" IS NULL OR "adapterMode" IN ('NATIVE', 'ADAPTED'))
  AND ("adapterVersion" IS NULL OR ("adapterMode" = 'ADAPTED' AND length("adapterVersion") <= 32))
  AND ("admissionFencingToken" IS NULL OR "admissionFencingToken" > 0)
  AND ("waitDurationMs" IS NULL OR "waitDurationMs" >= 0)
  AND ("contextTokens" IS NULL OR "contextTokens" >= 0)
);

INSERT INTO relay_execution_attempt
  ("attemptId", "createdAt", "updatedAt", "userId", "relayRequestId", "ownerEpoch",
   "heartbeatAt", "expiresAt", state, "terminalAt", "terminalState", "attemptKind",
   "requestedSurface", "nativeSurface",
   "adapterMode", "adapterVersion", "poolId", "poolMemberId", "executionTargetId", "memberTier")
SELECT DISTINCT ON (event."attemptId")
  event."attemptId", event."createdAt", event."createdAt", event."userId", event."relayRequestId",
  'historical-split', event."createdAt", event."createdAt",
  COALESCE((SELECT terminal."terminalState" FROM relay_execution_event terminal
    WHERE terminal."attemptId" = event."attemptId"
      AND terminal."eventType" IN ('TERMINAL', 'CRASH_RECOVERED')
    ORDER BY terminal."createdAt" DESC LIMIT 1), 'ACTIVE'),
  (SELECT MAX(terminal."createdAt") FROM relay_execution_event terminal
    WHERE terminal."attemptId" = event."attemptId"
      AND terminal."eventType" IN ('TERMINAL', 'CRASH_RECOVERED')),
  (SELECT terminal."terminalState" FROM relay_execution_event terminal
    WHERE terminal."attemptId" = event."attemptId"
      AND terminal."eventType" IN ('TERMINAL', 'CRASH_RECOVERED')
    ORDER BY terminal."createdAt" DESC LIMIT 1),
  event."attemptKind", event."requestedSurface", event."nativeSurface", event."adapterMode",
  event."adapterVersion", event."poolId", event."poolMemberId", event."executionTargetId",
  event."memberTier"
FROM relay_execution_event event
WHERE event."eventType" = 'ATTEMPT_STARTED'
ON CONFLICT ("attemptId") DO NOTHING;

-- No statement in this file may move relay_request out of PENDING: every
-- terminal transition must go through the application's status-guarded path
-- that writes the usage rollup in the same transaction (usage-rollup.ts).
-- verify-schema-hardening.mjs rejects any `UPDATE relay_request ... status`.

ALTER TABLE relay_execution_attempt DROP CONSTRAINT IF EXISTS relay_execution_attempt_shape_check;
ALTER TABLE relay_execution_attempt ADD CONSTRAINT relay_execution_attempt_shape_check CHECK (
  state IN ('ACTIVE', 'SUCCEEDED', 'FAILED', 'CANCELED')
  AND "attemptKind" IN ('EXECUTION', 'CONTEXT_COUNT')
  AND btrim("ownerEpoch") <> ''
  AND "expiresAt" >= "heartbeatAt"
  AND ((state = 'ACTIVE' AND "terminalAt" IS NULL AND "terminalState" IS NULL)
    OR (state <> 'ACTIVE' AND "terminalAt" IS NOT NULL AND "terminalState" = state))
);

CREATE OR REPLACE FUNCTION enforce_relay_execution_attempt_transition()
RETURNS trigger LANGUAGE plpgsql AS $relay_execution_attempt_transition$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
     OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."relayRequestId" IS DISTINCT FROM OLD."relayRequestId"
     OR NEW."attemptKind" IS DISTINCT FROM OLD."attemptKind"
     OR NEW."requestedSurface" IS DISTINCT FROM OLD."requestedSurface"
     OR NEW."nativeSurface" IS DISTINCT FROM OLD."nativeSurface"
     OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
     OR NEW."poolMemberId" IS DISTINCT FROM OLD."poolMemberId"
     OR NEW."executionTargetId" IS DISTINCT FROM OLD."executionTargetId" THEN
    RAISE EXCEPTION 'relay execution attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."ownerEpoch" IS DISTINCT FROM OLD."ownerEpoch" AND NEW.state = 'ACTIVE' THEN
    RAISE EXCEPTION 'active relay execution ownership is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'terminal relay execution attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."heartbeatAt" < OLD."heartbeatAt" OR NEW."expiresAt" < NEW."heartbeatAt" THEN
    RAISE EXCEPTION 'invalid relay execution heartbeat' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$relay_execution_attempt_transition$;
DROP TRIGGER IF EXISTS relay_execution_attempt_transition ON relay_execution_attempt;
CREATE TRIGGER relay_execution_attempt_transition
BEFORE UPDATE OR DELETE ON relay_execution_attempt
FOR EACH ROW EXECUTE FUNCTION enforce_relay_execution_attempt_transition();

-- Partial indexes document and enforce the live-winner invariant even if a
-- future archival change relaxes the stronger one-lease-per-attempt FK.
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_one_admitted_winner
  ON capacity_waiter ("admissionRequestId") WHERE state = 'ADMITTED';
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_unique_direct_candidate
  ON capacity_waiter ("admissionRequestId", "capacityId", "executionTargetId")
  WHERE "poolMemberId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capacity_lease_one_live_attempt
  ON capacity_lease ("admissionRequestId") WHERE state = 'ACTIVE';

-- Hot-path admission rows (writer class H) have no foreign key to the graph
-- (DL-1 design (d), #78), so these checks are the integrity boundary. They
-- are plain SELECTs (no row lock, so they add nothing to any lock order) and
-- tolerate a deleted parent: a waiter or lease that names a pool, member,
-- target or capacity deleted concurrently is an orphan the capacity sweeper
-- terminalizes, never a row that contradicts a live parent. A live parent is
-- always checked.
CREATE OR REPLACE FUNCTION enforce_capacity_reference_consistency()
RETURNS trigger LANGUAGE plpgsql AS $capacity_reference_check$
DECLARE
  request_owner TEXT;
  request_pool TEXT;
  request_direct_target TEXT;
  target_found BOOLEAN;
  request_base_priority INTEGER;
  request_priority_grant TEXT;
  target_owner TEXT;
  target_capacity TEXT;
  member_found BOOLEAN;
  member_pool TEXT;
  member_target TEXT;
  parent_owner TEXT;
BEGIN
  IF TG_TABLE_NAME = 'execution_target' THEN
    IF NEW."inferenceCapacityId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM inference_capacity capacity
       WHERE capacity.id = NEW."inferenceCapacityId" AND capacity."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'execution target capacity must have the same owner'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'admission_request' THEN
    IF NEW."poolId" IS NOT NULL THEN
      SELECT "userId" INTO parent_owner FROM model_pool WHERE id = NEW."poolId";
      IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'admission request pool must have the same owner'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."directExecutionTargetId" IS NOT NULL THEN
      SELECT "userId" INTO parent_owner FROM execution_target
       WHERE id = NEW."directExecutionTargetId";
      IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'direct admission target must have the same owner'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT "userId", "poolId", "directExecutionTargetId", "basePriority", "priorityGrantId"
    INTO request_owner, request_pool, request_direct_target, request_base_priority,
      request_priority_grant
    FROM admission_request WHERE id = NEW."admissionRequestId";
  SELECT true, "userId", "inferenceCapacityId" INTO target_found, target_owner, target_capacity
    FROM execution_target WHERE id = NEW."executionTargetId";
  IF request_owner IS NULL OR request_owner <> NEW."userId"
     OR (target_found AND (target_owner <> NEW."userId"
       OR target_capacity IS DISTINCT FROM NEW."capacityId")) THEN
    RAISE EXCEPTION 'capacity admission references must share owner and physical capacity'
      USING ERRCODE = '23514';
  END IF;
  -- Do not combine the table guard and waiter-only record fields in one SQL
  -- boolean expression. PostgreSQL may resolve every NEW/OLD field before
  -- applying boolean short-circuiting, and capacity_lease has no policy fields.
  IF TG_TABLE_NAME = 'capacity_waiter' THEN
    IF TG_OP = 'UPDATE'
       AND (NEW."effectivePriority" IS DISTINCT FROM OLD."effectivePriority"
         OR NEW."effectiveConcurrencyLimit" IS DISTINCT FROM OLD."effectiveConcurrencyLimit"
         OR NEW."effectiveConcurrencyScope" IS DISTINCT FROM OLD."effectiveConcurrencyScope"
         OR NEW."effectiveConcurrencyScopeId" IS DISTINCT FROM OLD."effectiveConcurrencyScopeId"
         OR NEW."effectiveReservedSlots" IS DISTINCT FROM OLD."effectiveReservedSlots"
         OR NEW."effectiveBorrowPolicy" IS DISTINCT FROM OLD."effectiveBorrowPolicy") THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('capacity_waiter', 'capacity_lease') AND NOT EXISTS (
    SELECT 1 FROM admission_request request
     WHERE request.id = NEW."admissionRequestId"
       AND request."requestId" = NEW."requestId"
       AND request."attemptId" = NEW."attemptId"
  ) THEN
    RAISE EXCEPTION 'capacity lease request and attempt identity must match admission request'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."poolMemberId" IS NOT NULL THEN
    SELECT true, "poolId", "executionTargetId" INTO member_found, member_pool, member_target
      FROM pool_member WHERE id = NEW."poolMemberId";
    IF request_pool IS DISTINCT FROM NEW."poolId"
       OR (member_found AND (member_pool IS DISTINCT FROM NEW."poolId"
         OR member_target IS DISTINCT FROM NEW."executionTargetId")) THEN
      RAISE EXCEPTION 'capacity admission pool candidate is inconsistent'
        USING ERRCODE = '23514';
    END IF;
  ELSIF request_pool IS NOT NULL THEN
    RAISE EXCEPTION 'pool admission requires a pool member candidate'
      USING ERRCODE = '23514';
  ELSIF request_direct_target IS DISTINCT FROM NEW."executionTargetId" THEN
    RAISE EXCEPTION 'direct admission candidate must match its source target'
      USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'capacity_waiter' THEN
    IF NEW."poolMemberId" IS NOT NULL AND member_found AND NOT EXISTS (
      SELECT 1
        FROM pool_member member
        JOIN model_pool pool ON pool.id = member."poolId"
       WHERE member.id = NEW."poolMemberId"
         -- S-C: a grantee's grant queue priority (recorded on the request
         -- when the attempt was created) replaces the pool/member priority.
         AND (NEW."effectivePriority" = COALESCE(member."capacityPriority", pool."capacityPriority")
           OR (request_priority_grant IS NOT NULL
             AND NEW."effectivePriority" = request_base_priority))
         AND NEW."effectiveConcurrencyLimit" IS NOT DISTINCT FROM
           CASE member."capacityConcurrencyMode"
             WHEN 'LIMITED' THEN member."capacityConcurrencyLimit"
             WHEN 'UNLIMITED' THEN NULL
             ELSE pool."capacityConcurrencyLimit" END
         AND NEW."effectiveConcurrencyScope" = CASE
           WHEN member."capacityConcurrencyMode" = 'INHERIT' THEN 'POOL' ELSE 'MEMBER' END
         AND NEW."effectiveConcurrencyScopeId" = CASE
           WHEN member."capacityConcurrencyMode" = 'INHERIT' THEN pool.id ELSE member.id END
         AND NEW."effectiveReservedSlots" = COALESCE(member."capacityReservedSlots", pool."capacityReservedSlots")
         AND NEW."effectiveBorrowPolicy" = COALESCE(member."capacityBorrowPolicy", pool."capacityBorrowPolicy")
    ) THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot must match its pool member policy'
        USING ERRCODE = '23514';
    ELSIF NEW."poolMemberId" IS NULL AND target_found AND NOT EXISTS (
      SELECT 1 FROM execution_target target
       WHERE target.id = NEW."executionTargetId"
         AND NEW."effectivePriority" = target."directPriority"
         AND NEW."effectiveConcurrencyLimit" IS NOT DISTINCT FROM target."directConcurrencyLimit"
         AND NEW."effectiveConcurrencyScope" = 'DIRECT_TARGET'
         AND NEW."effectiveConcurrencyScopeId" = target.id
         AND NEW."effectiveReservedSlots" = target."directReservedSlots"
         AND NEW."effectiveBorrowPolicy" = target."directBorrowPolicy"
    ) THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot must match its direct target policy'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$capacity_reference_check$;

DROP TRIGGER IF EXISTS execution_target_capacity_consistency ON execution_target;
CREATE TRIGGER execution_target_capacity_consistency
BEFORE INSERT OR UPDATE OF "userId", "inferenceCapacityId" ON execution_target
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();

DROP TRIGGER IF EXISTS admission_request_reference_consistency ON admission_request;
CREATE TRIGGER admission_request_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "sourceKind", "poolId", "directExecutionTargetId"
ON admission_request
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();

DROP TRIGGER IF EXISTS capacity_waiter_reference_consistency ON capacity_waiter;
CREATE TRIGGER capacity_waiter_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "admissionRequestId", "requestId", "attemptId", "capacityId",
  "executionTargetId", "poolId", "poolMemberId", "effectivePriority", "effectiveConcurrencyLimit",
  "effectiveConcurrencyScope", "effectiveConcurrencyScopeId", "effectiveReservedSlots",
  "effectiveBorrowPolicy" ON capacity_waiter
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();

DROP TRIGGER IF EXISTS capacity_lease_reference_consistency ON capacity_lease;
CREATE TRIGGER capacity_lease_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "admissionRequestId", "requestId", "attemptId", "capacityId",
  "executionTargetId", "poolId", "poolMemberId" ON capacity_lease
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();

-- The Prisma field remains text so deployments can add future API surfaces
-- without a PostgreSQL enum migration. Normalize legacy/out-of-band values and
-- constrain storage to the surfaces understood by this application version.
UPDATE model_pool
   SET "recommendedSurfaceOverride" = NULL
 WHERE "recommendedSurfaceOverride" IS NOT NULL
   AND "recommendedSurfaceOverride" NOT IN (
     'OPENAI_CHAT_COMPLETIONS',
     'OPENAI_RESPONSES',
     'ANTHROPIC_MESSAGES'
   );

ALTER TABLE model_pool
  DROP CONSTRAINT IF EXISTS model_pool_recommended_surface_override_check;
ALTER TABLE model_pool
  ADD CONSTRAINT model_pool_recommended_surface_override_check CHECK (
    "recommendedSurfaceOverride" IS NULL
    OR "recommendedSurfaceOverride" IN (
      'OPENAI_CHAT_COMPLETIONS',
      'OPENAI_RESPONSES',
      'ANTHROPIC_MESSAGES'
    )
  );

-- Build the expected constraint through PostgreSQL itself so comparison is not
-- coupled to pg_get_constraintdef's whitespace or parenthesis formatting.
CREATE TEMP TABLE execution_target_expected_constraint (
  kind "ExecutionTargetKind" NOT NULL,
  "discoveredModelId" TEXT,
  "providerModelId" TEXT,
  CONSTRAINT execution_target_kind_source_xor_check CHECK (
    (kind = 'DISCOVERED_MODEL' AND "discoveredModelId" IS NOT NULL AND "providerModelId" IS NULL)
    OR
    (kind = 'PROVIDER_MODEL' AND "providerModelId" IS NOT NULL AND "discoveredModelId" IS NULL)
  )
) ON COMMIT DROP;

DO $hardening$
DECLARE
  actual_definition TEXT;
  expected_definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid)
    INTO actual_definition
    FROM pg_constraint
   WHERE conrelid = 'execution_target'::regclass
     AND conname = 'execution_target_kind_source_xor_check';

  SELECT pg_get_constraintdef(oid)
    INTO expected_definition
    FROM pg_constraint
   WHERE conrelid = 'execution_target_expected_constraint'::regclass
     AND conname = 'execution_target_kind_source_xor_check';

  IF actual_definition IS DISTINCT FROM expected_definition THEN
    IF actual_definition IS NOT NULL THEN
      ALTER TABLE execution_target
        DROP CONSTRAINT execution_target_kind_source_xor_check;
    END IF;

    ALTER TABLE execution_target
      ADD CONSTRAINT execution_target_kind_source_xor_check CHECK (
        (kind = 'DISCOVERED_MODEL' AND "discoveredModelId" IS NOT NULL AND "providerModelId" IS NULL)
        OR
        (kind = 'PROVIDER_MODEL' AND "providerModelId" IS NOT NULL AND "discoveredModelId" IS NULL)
      );
  END IF;
END;
$hardening$;

-- Execution-target identity is immutable. Consumers may safely treat an ID as
-- a stable owner/kind/source tuple; source rows remain deletable through FKs.
CREATE OR REPLACE FUNCTION enforce_execution_target_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $target_identity$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW."discoveredModelId" IS DISTINCT FROM OLD."discoveredModelId"
     OR NEW."providerModelId" IS DISTINCT FROM OLD."providerModelId" THEN
    RAISE EXCEPTION 'execution target identity and source are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$target_identity$;

DROP TRIGGER IF EXISTS execution_target_identity_immutable ON execution_target;
CREATE TRIGGER execution_target_identity_immutable
BEFORE UPDATE OF "userId", kind, "discoveredModelId", "providerModelId" ON execution_target
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_identity_immutable();

-- Old application instances know only about discovered_model. Create the new
-- identity in the same transaction as every old-style insert so target-backed
-- consumers never race a missing execution target during a rolling deploy.
CREATE OR REPLACE FUNCTION create_discovered_model_execution_target()
RETURNS trigger LANGUAGE plpgsql AS $create_discovered_target$
BEGIN
  INSERT INTO execution_target (
    id, "createdAt", "updatedAt", "userId", kind, "discoveredModelId"
  ) VALUES (
    'et_dm_' || md5(NEW.id), NEW."createdAt", NOW(), NEW."userId",
    'DISCOVERED_MODEL'::"ExecutionTargetKind", NEW.id
  )
  ON CONFLICT ("discoveredModelId") DO NOTHING;
  RETURN NEW;
END;
$create_discovered_target$;

DROP TRIGGER IF EXISTS discovered_model_create_execution_target ON discovered_model;
CREATE TRIGGER discovered_model_create_execution_target
AFTER INSERT ON discovered_model
FOR EACH ROW EXECUTE FUNCTION create_discovered_model_execution_target();

-- Deterministic IDs make this safe to rerun and allow an interrupted rollout
-- to resume without producing duplicate execution targets.
INSERT INTO execution_target (
  id,
  "createdAt",
  "updatedAt",
  "userId",
  kind,
  "discoveredModelId"
)
SELECT
  'et_dm_' || md5(discovered_model.id),
  discovered_model."createdAt",
  NOW(),
  discovered_model."userId",
  'DISCOVERED_MODEL'::"ExecutionTargetKind",
  discovered_model.id
FROM discovered_model
ON CONFLICT ("discoveredModelId") DO NOTHING;

-- Give every pre-capacity execution target a conservative private identity.
-- We cannot safely infer that two independently published targets share a
-- physical engine, so the backfill intentionally creates one capacity per
-- target. Owners can explicitly consolidate them later.
INSERT INTO inference_capacity (
  id, "createdAt", "updatedAt", "userId", label, "runtimeIdentityKey", "runtimeModel",
  "hardConcurrencyLimitSource"
)
SELECT
  'cap_' || md5(target.id), target."createdAt", NOW(), target."userId",
  COALESCE(model."upstreamModelId", provider_model."upstreamModelId", target.id)
    || ' (' || target.id || ')',
  'execution-target:' || target.id,
  COALESCE(model."upstreamModelId", provider_model."upstreamModelId", target.id),
  -- Auto-created with a null limit: the application fills it (AUTO only).
  'AUTO'::"CapacityLimitSource"
FROM execution_target target
LEFT JOIN discovered_model model ON model.id = target."discoveredModelId"
LEFT JOIN provider_model ON provider_model.id = target."providerModelId"
WHERE target."inferenceCapacityId" IS NULL
ON CONFLICT ("userId", "runtimeIdentityKey") DO NOTHING;

UPDATE execution_target target
   SET "inferenceCapacityId" = capacity.id
  FROM inference_capacity capacity
 WHERE target."inferenceCapacityId" IS NULL
   AND capacity."userId" = target."userId"
   AND capacity."runtimeIdentityKey" = 'execution-target:' || target.id;

CREATE OR REPLACE FUNCTION create_execution_target_capacity()
RETURNS trigger LANGUAGE plpgsql AS $create_target_capacity$
DECLARE
  model_name TEXT;
  capacity_id TEXT;
BEGIN
  IF NEW."inferenceCapacityId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."discoveredModelId" IS NOT NULL THEN
    SELECT "upstreamModelId" INTO model_name FROM discovered_model
     WHERE id = NEW."discoveredModelId";
  ELSE
    SELECT "upstreamModelId" INTO model_name FROM provider_model
     WHERE id = NEW."providerModelId";
  END IF;
  model_name := COALESCE(model_name, NEW.id);
  capacity_id := 'cap_' || md5(NEW.id);
  INSERT INTO inference_capacity (
    id, "createdAt", "updatedAt", "userId", label, "runtimeIdentityKey", "runtimeModel",
    "hardConcurrencyLimitSource"
  ) VALUES (
    capacity_id, NEW."createdAt", NOW(), NEW."userId",
    model_name || ' (' || NEW.id || ')',
    'execution-target:' || NEW.id, model_name, 'AUTO'::"CapacityLimitSource"
  ) ON CONFLICT ("userId", "runtimeIdentityKey") DO UPDATE
    SET "updatedAt" = EXCLUDED."updatedAt"
  RETURNING id INTO capacity_id;
  NEW."inferenceCapacityId" := capacity_id;
  RETURN NEW;
END;
$create_target_capacity$;

DROP TRIGGER IF EXISTS execution_target_capacity_backfill ON execution_target;
CREATE TRIGGER execution_target_capacity_backfill
BEFORE INSERT ON execution_target
FOR EACH ROW EXECUTE FUNCTION create_execution_target_capacity();

-- "hardConcurrencyLimitSource" was added with default AUTO, so limits users
-- saved before it existed (including null = unlimited) look auto-generated and
-- the discovered-capacity fill would overwrite them. Recover the user intent
-- from the audit trail. Both statements only move AUTO to USER, never back, so
-- rerunning them is safe.
--
-- capacityManagement.create audits resourceType INFERENCE_CAPACITY, action
-- CREATE, after = the validated input (hardConcurrencyLimit is required).
-- capacityManagement.update audits action UPDATE, after = the full updated row.
-- The web capacity form always sends hardConcurrencyLimit, so any legacy
-- UPDATE saved the limit. Current writers include "hardConcurrencyLimitSource"
-- in the audited row and mark USER themselves, so only UPDATE rows without
-- that key are treated as legacy user saves here. An UPDATE made through the
-- API without the limit key before this column existed is also counted; the
-- audit row cannot tell it apart.
UPDATE inference_capacity capacity
   SET "hardConcurrencyLimitSource" = 'USER'
 WHERE capacity."hardConcurrencyLimitSource" = 'AUTO'
   AND EXISTS (
     SELECT 1
       FROM capacity_audit_event edit
      WHERE edit."resourceType" = 'INFERENCE_CAPACITY'
        AND edit."resourceId" = capacity.id
        AND edit."userId" = capacity."userId"
        AND jsonb_typeof(edit.after) = 'object'
        AND edit.after ? 'hardConcurrencyLimit'
        AND (edit.action = 'CREATE'
          OR (edit.action = 'UPDATE'
            AND NOT (edit.after ? 'hardConcurrencyLimitSource')))
   );

-- providerManagement.updateModel copies the provider model limit into the
-- capacity attached to that model's execution target and records
-- MODEL_UPDATED with a "nextConcurrencyLimit" metadata key; the audit event
-- names only the provider model. The capacity it wrote is the one the target
-- was attached to at that moment. The discovered-capacity fill can only reach
-- a provider target's capacity when capacityManagement.updateDirectPolicy
-- attached it (EXECUTION_TARGET / UPDATE_POLICY with "inferenceCapacityId" in
-- after); the trigger and provider-model attachments use keys the fill never
-- matches. So a capacity counts when the target's latest audited attachment at
-- or before the edit points at it. A detach audits a null id and never matches.
UPDATE inference_capacity capacity
   SET "hardConcurrencyLimitSource" = 'USER'
 WHERE capacity."hardConcurrencyLimitSource" = 'AUTO'
   AND EXISTS (
     SELECT 1
       FROM provider_audit_event edit
       JOIN execution_target target
         ON target."providerModelId" = edit."subjectId"
        AND target."userId" = edit."userId"
      WHERE edit.action = 'MODEL_UPDATED'
        AND edit."userId" = capacity."userId"
        AND jsonb_typeof(edit.metadata) = 'object'
        AND edit.metadata ? 'nextConcurrencyLimit'
        AND (
          SELECT attachment.after ->> 'inferenceCapacityId'
            FROM capacity_audit_event attachment
           WHERE attachment."resourceType" = 'EXECUTION_TARGET'
             AND attachment.action = 'UPDATE_POLICY'
             AND attachment."resourceId" = target.id
             AND attachment."userId" = edit."userId"
             AND jsonb_typeof(attachment.after) = 'object'
             AND attachment.after ? 'inferenceCapacityId'
             AND attachment."createdAt" <= edit."createdAt"
           ORDER BY attachment."createdAt" DESC, attachment.id DESC
           LIMIT 1
        ) = capacity.id
   );

-- Never guess how to merge independently configured duplicate rows. Updating
-- the legacy representation would violate the new uniqueness constraint, so
-- abort with the exact row identities and leave both rows untouched for an
-- operator to reconcile deliberately.
DO $consumer_conflicts$
DECLARE
  conflict_detail TEXT;
BEGIN
  SELECT string_agg(
           format('pool=%s model=%s legacyRow=%s targetRow=%s',
             legacy."poolId", legacy."discoveredModelId", legacy.id, canonical.id),
           '; ' ORDER BY legacy."poolId", legacy."discoveredModelId", legacy.id
         )
    INTO conflict_detail
    FROM pool_member AS legacy
    JOIN execution_target AS target
      ON target."discoveredModelId" = legacy."discoveredModelId"
    JOIN pool_member AS canonical
      ON canonical."poolId" = legacy."poolId"
     AND canonical."executionTargetId" = target.id
   WHERE legacy."executionTargetId" IS NULL;

  IF conflict_detail IS NOT NULL THEN
    RAISE EXCEPTION 'execution-target hardening found duplicate pool members; reconcile these rows and retry'
      USING ERRCODE = '23505', DETAIL = conflict_detail,
            HINT = 'Keep the intended configuration in one row and remove the other explicitly before retrying.';
  END IF;

  SELECT string_agg(
           format('token=%s model=%s legacyRow=%s targetRow=%s',
             legacy."modelApiTokenId", legacy."discoveredModelId", legacy.id, canonical.id),
           '; ' ORDER BY legacy."modelApiTokenId", legacy."discoveredModelId", legacy.id
         )
    INTO conflict_detail
    FROM model_api_token_allowlist_entry AS legacy
    JOIN execution_target AS target
      ON target."discoveredModelId" = legacy."discoveredModelId"
    JOIN model_api_token_allowlist_entry AS canonical
      ON canonical."modelApiTokenId" = legacy."modelApiTokenId"
     AND canonical."executionTargetId" = target.id
   WHERE legacy."executionTargetId" IS NULL;

  IF conflict_detail IS NOT NULL THEN
    RAISE EXCEPTION 'execution-target hardening found duplicate token allowlist entries; reconcile these rows and retry'
      USING ERRCODE = '23505', DETAIL = conflict_detail,
            HINT = 'Keep the intended access rule in one row and remove the other explicitly before retrying.';
  END IF;
END;
$consumer_conflicts$;

-- Complete either half of compatibility rows that were committed by a newer
-- instance before this hardening revision installed the bidirectional trigger.
-- Provider targets intentionally have no legacy discovered-model identity.
UPDATE pool_member AS consumer
   SET "discoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."discoveredModelId" IS NULL
   AND consumer."executionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE model_api_token_allowlist_entry AS consumer
   SET "discoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."discoveredModelId" IS NULL
   AND consumer."executionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE response_stickiness_record AS consumer
   SET "targetDiscoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."targetDiscoveredModelId" IS NULL
   AND consumer."targetExecutionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE response_stickiness_record AS consumer
   SET "selectedDiscoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."selectedDiscoveredModelId" IS NULL
   AND consumer."selectedExecutionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE relay_request AS consumer
   SET "requestedDiscoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."requestedDiscoveredModelId" IS NULL
   AND consumer."requestedExecutionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE relay_request AS consumer
   SET "selectedDiscoveredModelId" = target."discoveredModelId"
  FROM execution_target AS target
 WHERE consumer."selectedDiscoveredModelId" IS NULL
   AND consumer."selectedExecutionTargetId" = target.id
   AND target."discoveredModelId" IS NOT NULL;

UPDATE pool_member AS consumer
   SET "executionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."executionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."discoveredModelId";

UPDATE model_api_token_allowlist_entry AS consumer
   SET "executionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."executionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."discoveredModelId";

UPDATE response_stickiness_record AS consumer
   SET "targetExecutionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."targetExecutionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."targetDiscoveredModelId";

UPDATE response_stickiness_record AS consumer
   SET "selectedExecutionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."selectedExecutionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."selectedDiscoveredModelId";

-- Version-3 grantee bindings written before exact grant identity was added are
-- backfilled only from the unique grant that currently establishes visibility.
-- Missing grants remain null and are rejected by the pre-trigger audit below.
UPDATE response_stickiness_record AS record
   SET "poolGrantId" = grant_row.id
  FROM model_pool pool, pool_grant grant_row
 WHERE record."routingVersion" >= 3
   AND record."poolGrantId" IS NULL
   AND pool.id = record."targetModelPoolId"
   AND record."userId" <> pool."userId"
   AND grant_row."poolId" = pool.id
   AND grant_row."ownerUserId" = pool."userId"
   AND grant_row."granteeUserId" = record."userId";

-- Install immutability only after the one-time compatibility backfill above.
-- Existing v3 grantee bindings may legitimately need their exact grant ID
-- filled in; all subsequent application writes remain immutable.
DROP TRIGGER IF EXISTS response_stickiness_provider_binding_immutable
  ON response_stickiness_record;
CREATE TRIGGER response_stickiness_provider_binding_immutable
BEFORE UPDATE ON response_stickiness_record
FOR EACH ROW EXECUTE FUNCTION enforce_response_stickiness_provider_binding_immutable();

UPDATE relay_request AS consumer
   SET "requestedExecutionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."requestedExecutionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."requestedDiscoveredModelId";

UPDATE relay_request AS consumer
   SET "selectedExecutionTargetId" = target.id
  FROM execution_target AS target
 WHERE consumer."selectedExecutionTargetId" IS NULL
   AND target."discoveredModelId" = consumer."selectedDiscoveredModelId";

-- Row triggers do not validate data that predates their installation. Refuse
-- to bless cross-owner, mismatched, or incorrectly typed target references;
-- the surrounding transaction rolls every backfill change back and reports
-- the exact consumer rows an operator must reconcile.
DO $invalid_consumers$
DECLARE
  invalid_detail TEXT;
BEGIN
  SELECT string_agg(detail, '; ' ORDER BY detail) INTO invalid_detail
  FROM (
    SELECT format('pool_member row=%s', member.id) AS detail
      FROM pool_member member
      JOIN model_pool pool ON pool.id = member."poolId"
      JOIN execution_target target ON target.id = member."executionTargetId"
     WHERE target."userId" <> pool."userId"
        OR (member."discoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM member."discoveredModelId")
    UNION ALL
    SELECT format('allowlist row=%s', entry.id)
      FROM model_api_token_allowlist_entry entry
      JOIN model_api_token token ON token.id = entry."modelApiTokenId"
      JOIN execution_target target ON target.id = entry."executionTargetId"
     WHERE entry.target <> 'DIRECT_MODEL'::"ModelApiTokenAllowlistTarget"
        OR target."userId" <> token."userId"
        OR (entry."discoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM entry."discoveredModelId")
    UNION ALL
    SELECT format('stickiness target row=%s', record.id)
      FROM response_stickiness_record record
      JOIN execution_target target ON target.id = record."targetExecutionTargetId"
     WHERE record."routingVersion" < 3
       AND (target."userId" <> record."userId"
        OR (record."targetDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM record."targetDiscoveredModelId"))
    UNION ALL
    -- Local pool bindings belong to the pool owner's graph: the requester is
    -- the owner (no grant) or holds the exact grant. Membership is checked only
    -- when a selection is written, so it is not re-audited here.
    SELECT format('stickiness selection row=%s', record.id)
      FROM response_stickiness_record record
      JOIN execution_target target ON target.id = record."selectedExecutionTargetId"
      LEFT JOIN model_pool pool ON pool.id = record."targetModelPoolId"
     WHERE record."routingVersion" < 3
       AND (target."userId" IS DISTINCT FROM CASE
              WHEN record."targetModelPoolId" IS NULL THEN record."userId"
              ELSE pool."userId"
            END
        OR (record."selectedDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM record."selectedDiscoveredModelId"))
    UNION ALL
    SELECT format('stickiness mixed target row=%s', record.id)
      FROM response_stickiness_record record
     WHERE record."routingVersion" < 3
       AND record."targetModelPoolId" IS NOT NULL
       AND (record."targetExecutionTargetId" IS NOT NULL
         OR record."targetDiscoveredModelId" IS NOT NULL)
    UNION ALL
    SELECT format('stickiness pool grant row=%s', record.id)
      FROM response_stickiness_record record
      LEFT JOIN model_pool pool ON pool.id = record."targetModelPoolId"
     WHERE record."routingVersion" < 3
       AND record."targetModelPoolId" IS NOT NULL
       -- DL-1 (d): stickiness is hot-path history without foreign keys; a
       -- binding whose pool or grant was deleted is an orphan (never served
       -- again), not an inconsistency. Only a live parent that disagrees is.
       AND pool.id IS NOT NULL
       AND ((record."poolGrantId" IS NULL AND pool."userId" IS DISTINCT FROM record."userId")
         OR (record."poolGrantId" IS NOT NULL AND (
           pool."userId" IS NOT DISTINCT FROM record."userId"
           OR EXISTS (
             SELECT 1 FROM pool_grant grant_row
              WHERE grant_row.id = record."poolGrantId"
                AND (grant_row."poolId" IS DISTINCT FROM record."targetModelPoolId"
                  OR grant_row."ownerUserId" IS DISTINCT FROM pool."userId"
                  OR grant_row."granteeUserId" IS DISTINCT FROM record."userId")))))
    UNION ALL
    SELECT format('provider stickiness graph row=%s', record.id)
      FROM response_stickiness_record record
      LEFT JOIN execution_target target ON target.id = record."selectedExecutionTargetId"
      LEFT JOIN provider_model model ON model.id = target."providerModelId"
      LEFT JOIN provider_account acct ON acct.id = model."providerAccountId"
      LEFT JOIN model_pool pool ON pool.id = record."targetModelPoolId"
      LEFT JOIN model_api_token token ON token.id = record."modelApiTokenId"
     WHERE record."routingVersion" >= 3
       -- DL-1 (d): an orphaned binding (its target, pool or token deleted) is
       -- tolerated; provider models and accounts are soft-deleted, never gone.
       AND target.id IS NOT NULL
       AND pool.id IS NOT NULL
       AND (model.id IS NULL
         OR acct.id IS NULL
         OR target."providerModelId" IS DISTINCT FROM record."providerModelId"
         OR model."providerAccountId" IS DISTINCT FROM record."providerAccountId"
         OR model."upstreamModelId" IS DISTINCT FROM record."providerUpstreamModelId"
         OR target."userId" IS DISTINCT FROM model."userId"
         OR model."userId" IS DISTINCT FROM acct."userId"
         OR (record."fallbackRoute" = 'own-key' AND (
           target."userId" IS DISTINCT FROM record."userId"
           OR pool."userId" IS NOT DISTINCT FROM record."userId"
           OR record."poolGrantId" IS NULL))
         -- Membership is checked only when the binding is written (the row
         -- is immutable afterwards, and follow-up routing re-lists the pool's
         -- members live). Removing a member or changing its tier is a normal
         -- operation, so it is not re-audited here.
         OR (record."fallbackRoute" IS DISTINCT FROM 'own-key'
           AND pool."userId" IS DISTINCT FROM target."userId")
         OR (token.id IS NOT NULL AND token."userId" IS DISTINCT FROM record."userId")
         OR (record."userId" IS NOT DISTINCT FROM pool."userId"
           AND record."poolGrantId" IS NOT NULL)
         OR (record."userId" IS DISTINCT FROM pool."userId" AND (
           record."poolGrantId" IS NULL OR EXISTS (
             SELECT 1 FROM pool_grant grant_row
              WHERE grant_row.id = record."poolGrantId"
                AND (grant_row."poolId" IS DISTINCT FROM record."targetModelPoolId"
                  OR grant_row."ownerUserId" IS DISTINCT FROM pool."userId"
                  OR grant_row."granteeUserId" IS DISTINCT FROM record."userId")
           )
         )))
    UNION ALL
    SELECT format('relay request target row=%s', request.id)
      FROM relay_request request
      JOIN execution_target target ON target.id = request."requestedExecutionTargetId"
     WHERE target."userId" <> request."userId"
        OR (request."requestedDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM request."requestedDiscoveredModelId")
    UNION ALL
    SELECT format('relay request selection row=%s', request.id)
      FROM relay_request request
      JOIN execution_target target ON target.id = request."selectedExecutionTargetId"
      LEFT JOIN model_pool pool ON pool.id = request."requestedModelPoolId"
     -- DL-1 (d): once the pool is gone the durable resource owner stands in
     -- for it, as in enforce_execution_target_consumer_consistency.
     WHERE target."userId" IS DISTINCT FROM CASE
             WHEN request."fallbackRoute" = 'own-key' OR request."requestedModelPoolId" IS NULL
               THEN request."userId"
             ELSE COALESCE(pool."userId", request."resourceOwnerUserId")
           END
        OR (request."selectedDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM request."selectedDiscoveredModelId")
  ) invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION 'execution-target hardening found invalid pre-existing consumer references; reconcile these rows and retry'
      USING ERRCODE = '23514', DETAIL = invalid_detail,
            HINT = 'Correct the owner/target/type mismatch explicitly; hardening left the original rows unchanged.';
  END IF;
END;
$invalid_consumers$;

-- Fallback redesign: a provider (external) Responses binding is honored only
-- when the request that created it explicitly asked for `owner/pool:external`
-- with caller consent. Version-3 bindings written before consent existed
-- (provider-backed PRIMARY members and automatic overflow) are invalidated
-- here; their follow-ups fail closed with "not found". Runs after the audit
-- above so invalid rows still stop hardening for operator review. A no-op once
-- applied: every new provider binding carries its route.
DELETE FROM response_stickiness_record
 WHERE "routingVersion" >= 3
   AND "fallbackRoute" IS NULL;

ALTER TABLE response_stickiness_record
  DROP CONSTRAINT IF EXISTS response_stickiness_fallback_route_check;
ALTER TABLE response_stickiness_record
  ADD CONSTRAINT response_stickiness_fallback_route_check CHECK (
    -- NULL-safe: a CHECK that evaluates to NULL passes, so a v3 row with a
    -- NULL route must compare FALSE here, not NULL.
    ("routingVersion" < 3 AND "fallbackRoute" IS NULL)
    OR ("routingVersion" >= 3 AND "fallbackRoute" IS NOT NULL AND "fallbackRoute" IN ('pool-external', 'own-key'))
  );

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_fallback_route_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_fallback_route_check CHECK (
  "fallbackRoute" IS NULL OR "fallbackRoute" IN ('local', 'pool-external', 'own-key')
);

ALTER TABLE model_pool DROP CONSTRAINT IF EXISTS model_pool_external_after_wait_check;
ALTER TABLE model_pool ADD CONSTRAINT model_pool_external_after_wait_check CHECK (
  "externalAfterWaitMs" BETWEEN 0 AND 600000
);

-- Saturation S-A: null = automatic, 0 = off, otherwise fixed (capped at 30 s).
ALTER TABLE model_pool DROP CONSTRAINT IF EXISTS model_pool_cache_holder_wait_check;
ALTER TABLE model_pool ADD CONSTRAINT model_pool_cache_holder_wait_check CHECK (
  "cacheHolderWaitMs" IS NULL OR "cacheHolderWaitMs" BETWEEN 0 AND 30000
);

-- Saturation S-C warm-session protection. Window 1 s..1 h, minimum size
-- 0..10M tokens, percents 1..100 (0 = unprotected for the owner/grant
-- overrides), and the fixed percent is present exactly for FIXED_PERCENT.
ALTER TABLE model_pool DROP CONSTRAINT IF EXISTS model_pool_protection_check;
ALTER TABLE model_pool ADD CONSTRAINT model_pool_protection_check CHECK (
  "protectionWindowSeconds" BETWEEN 1 AND 3600
  AND "protectMinTokens" BETWEEN 0 AND 10000000
  AND ("ownerProtectionPercent" IS NULL OR "ownerProtectionPercent" BETWEEN 0 AND 100)
  AND (("protectionShare" = 'FIXED_PERCENT' AND "protectionFixedPercent" BETWEEN 1 AND 100)
    OR ("protectionShare" <> 'FIXED_PERCENT' AND "protectionFixedPercent" IS NULL))
);

ALTER TABLE admission_request DROP CONSTRAINT IF EXISTS admission_request_priority_grant_check;
ALTER TABLE admission_request ADD CONSTRAINT admission_request_priority_grant_check CHECK (
  "priorityGrantId" IS NULL OR "poolId" IS NOT NULL
);

ALTER TABLE pool_grant DROP CONSTRAINT IF EXISTS pool_grant_protection_priority_check;
ALTER TABLE pool_grant ADD CONSTRAINT pool_grant_protection_priority_check CHECK (
  ("protectionOverridePercent" IS NULL OR "protectionOverridePercent" BETWEEN 0 AND 100)
  AND ("queuePriority" IS NULL OR "queuePriority" BETWEEN 0 AND 31)
);

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_affinity_wait_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_affinity_wait_check CHECK (
  "affinityWaitMs" IS NULL OR "affinityWaitMs" >= 0
);

-- Canonicalize compatibility writes before uniqueness and consistency checks.
-- This closes the mixed-representation hole where one row used only the
-- legacy model FK and another used the execution-target FK for the same model.
CREATE OR REPLACE FUNCTION canonicalize_execution_target_consumer()
RETURNS trigger LANGUAGE plpgsql AS $canonicalize_consumer$
DECLARE
  target_id TEXT;
  model_id TEXT;
BEGIN
  IF TG_TABLE_NAME IN ('pool_member', 'model_api_token_allowlist_entry') THEN
    target_id := NEW."executionTargetId";
    model_id := NEW."discoveredModelId";
    IF (TG_OP = 'INSERT' AND target_id IS NOT NULL AND model_id IS NULL)
         OR (TG_OP = 'UPDATE' AND target_id IS DISTINCT FROM OLD."executionTargetId"
           AND model_id IS NOT DISTINCT FROM OLD."discoveredModelId") THEN
      IF target_id IS NULL THEN
        NEW."discoveredModelId" := NULL;
      ELSE
        SELECT "discoveredModelId" INTO NEW."discoveredModelId"
          FROM execution_target WHERE id = target_id;
      END IF;
    ELSIF (TG_OP = 'INSERT' AND target_id IS NULL AND model_id IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND model_id IS DISTINCT FROM OLD."discoveredModelId"
            AND target_id IS NOT DISTINCT FROM OLD."executionTargetId") THEN
      IF model_id IS NULL THEN
        NEW."executionTargetId" := NULL;
      ELSE
        SELECT id INTO NEW."executionTargetId" FROM execution_target
         WHERE "discoveredModelId" = model_id;
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'response_stickiness_record' THEN
    IF (TG_OP = 'INSERT' AND NEW."targetExecutionTargetId" IS NOT NULL
          AND NEW."targetDiscoveredModelId" IS NULL)
         OR (TG_OP = 'UPDATE' AND NEW."targetExecutionTargetId" IS DISTINCT FROM OLD."targetExecutionTargetId"
           AND NEW."targetDiscoveredModelId" IS NOT DISTINCT FROM OLD."targetDiscoveredModelId") THEN
      IF NEW."targetExecutionTargetId" IS NULL THEN
        NEW."targetDiscoveredModelId" := NULL;
      ELSE
        SELECT "discoveredModelId" INTO NEW."targetDiscoveredModelId" FROM execution_target
         WHERE id = NEW."targetExecutionTargetId";
      END IF;
    ELSIF (TG_OP = 'INSERT' AND NEW."targetExecutionTargetId" IS NULL
            AND NEW."targetDiscoveredModelId" IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND NEW."targetDiscoveredModelId" IS DISTINCT FROM OLD."targetDiscoveredModelId"
            AND NEW."targetExecutionTargetId" IS NOT DISTINCT FROM OLD."targetExecutionTargetId") THEN
      IF NEW."targetDiscoveredModelId" IS NULL THEN
        NEW."targetExecutionTargetId" := NULL;
      ELSE
        SELECT id INTO NEW."targetExecutionTargetId" FROM execution_target
         WHERE "discoveredModelId" = NEW."targetDiscoveredModelId";
      END IF;
    END IF;
    IF (TG_OP = 'INSERT' AND NEW."selectedExecutionTargetId" IS NOT NULL
          AND NEW."selectedDiscoveredModelId" IS NULL)
         OR (TG_OP = 'UPDATE' AND NEW."selectedExecutionTargetId" IS DISTINCT FROM OLD."selectedExecutionTargetId"
           AND NEW."selectedDiscoveredModelId" IS NOT DISTINCT FROM OLD."selectedDiscoveredModelId") THEN
      IF NEW."selectedExecutionTargetId" IS NULL THEN
        NEW."selectedDiscoveredModelId" := NULL;
      ELSE
        SELECT "discoveredModelId" INTO NEW."selectedDiscoveredModelId" FROM execution_target
         WHERE id = NEW."selectedExecutionTargetId";
      END IF;
    ELSIF (TG_OP = 'INSERT' AND NEW."selectedExecutionTargetId" IS NULL
            AND NEW."selectedDiscoveredModelId" IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND NEW."selectedDiscoveredModelId" IS DISTINCT FROM OLD."selectedDiscoveredModelId"
            AND NEW."selectedExecutionTargetId" IS NOT DISTINCT FROM OLD."selectedExecutionTargetId") THEN
      IF NEW."selectedDiscoveredModelId" IS NULL THEN
        NEW."selectedExecutionTargetId" := NULL;
      ELSE
        SELECT id INTO NEW."selectedExecutionTargetId" FROM execution_target
         WHERE "discoveredModelId" = NEW."selectedDiscoveredModelId";
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'relay_request' THEN
    IF (TG_OP = 'INSERT' AND NEW."requestedExecutionTargetId" IS NOT NULL
          AND NEW."requestedDiscoveredModelId" IS NULL)
         OR (TG_OP = 'UPDATE' AND NEW."requestedExecutionTargetId" IS DISTINCT FROM OLD."requestedExecutionTargetId"
           AND NEW."requestedDiscoveredModelId" IS NOT DISTINCT FROM OLD."requestedDiscoveredModelId") THEN
      IF NEW."requestedExecutionTargetId" IS NULL THEN
        NEW."requestedDiscoveredModelId" := NULL;
      ELSE
        SELECT "discoveredModelId" INTO NEW."requestedDiscoveredModelId" FROM execution_target
         WHERE id = NEW."requestedExecutionTargetId";
      END IF;
    ELSIF (TG_OP = 'INSERT' AND NEW."requestedExecutionTargetId" IS NULL
            AND NEW."requestedDiscoveredModelId" IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND NEW."requestedDiscoveredModelId" IS DISTINCT FROM OLD."requestedDiscoveredModelId"
            AND NEW."requestedExecutionTargetId" IS NOT DISTINCT FROM OLD."requestedExecutionTargetId") THEN
      IF NEW."requestedDiscoveredModelId" IS NULL THEN
        NEW."requestedExecutionTargetId" := NULL;
      ELSE
        SELECT id INTO NEW."requestedExecutionTargetId" FROM execution_target
         WHERE "discoveredModelId" = NEW."requestedDiscoveredModelId";
      END IF;
    END IF;
    IF (TG_OP = 'INSERT' AND NEW."selectedExecutionTargetId" IS NOT NULL
          AND NEW."selectedDiscoveredModelId" IS NULL)
         OR (TG_OP = 'UPDATE' AND NEW."selectedExecutionTargetId" IS DISTINCT FROM OLD."selectedExecutionTargetId"
           AND NEW."selectedDiscoveredModelId" IS NOT DISTINCT FROM OLD."selectedDiscoveredModelId") THEN
      IF NEW."selectedExecutionTargetId" IS NULL THEN
        NEW."selectedDiscoveredModelId" := NULL;
      ELSE
        SELECT "discoveredModelId" INTO NEW."selectedDiscoveredModelId" FROM execution_target
         WHERE id = NEW."selectedExecutionTargetId";
      END IF;
    ELSIF (TG_OP = 'INSERT' AND NEW."selectedExecutionTargetId" IS NULL
            AND NEW."selectedDiscoveredModelId" IS NOT NULL)
          OR (TG_OP = 'UPDATE' AND NEW."selectedDiscoveredModelId" IS DISTINCT FROM OLD."selectedDiscoveredModelId"
            AND NEW."selectedExecutionTargetId" IS NOT DISTINCT FROM OLD."selectedExecutionTargetId") THEN
      IF NEW."selectedDiscoveredModelId" IS NULL THEN
        NEW."selectedExecutionTargetId" := NULL;
      ELSE
        SELECT id INTO NEW."selectedExecutionTargetId" FROM execution_target
         WHERE "discoveredModelId" = NEW."selectedDiscoveredModelId";
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$canonicalize_consumer$;

DROP TRIGGER IF EXISTS a_pool_member_canonicalize_execution_target ON pool_member;
CREATE TRIGGER a_pool_member_canonicalize_execution_target
BEFORE INSERT OR UPDATE OF "discoveredModelId", "executionTargetId" ON pool_member
FOR EACH ROW EXECUTE FUNCTION canonicalize_execution_target_consumer();

DROP TRIGGER IF EXISTS a_allowlist_canonicalize_execution_target
ON model_api_token_allowlist_entry;
CREATE TRIGGER a_allowlist_canonicalize_execution_target
BEFORE INSERT OR UPDATE OF "discoveredModelId", "executionTargetId"
ON model_api_token_allowlist_entry
FOR EACH ROW EXECUTE FUNCTION canonicalize_execution_target_consumer();

DROP TRIGGER IF EXISTS a_stickiness_canonicalize_execution_target ON response_stickiness_record;
CREATE TRIGGER a_stickiness_canonicalize_execution_target
BEFORE INSERT OR UPDATE OF "targetDiscoveredModelId", "targetExecutionTargetId",
  "selectedDiscoveredModelId", "selectedExecutionTargetId" ON response_stickiness_record
FOR EACH ROW EXECUTE FUNCTION canonicalize_execution_target_consumer();

DROP TRIGGER IF EXISTS a_relay_request_canonicalize_execution_target ON relay_request;
CREATE TRIGGER a_relay_request_canonicalize_execution_target
BEFORE INSERT OR UPDATE OF "requestedDiscoveredModelId", "requestedExecutionTargetId",
  "selectedDiscoveredModelId", "selectedExecutionTargetId" ON relay_request
FOR EACH ROW EXECUTE FUNCTION canonicalize_execution_target_consumer();

-- Compatibility consumers retain their legacy discovered-model columns for a
-- rollback window. Reject cross-owner and mismatched dual writes at the DB
-- boundary while continuing to permit nullable historical telemetry.
CREATE OR REPLACE FUNCTION enforce_execution_target_consumer_consistency()
RETURNS trigger LANGUAGE plpgsql AS $consumer_check$
DECLARE
  target_owner TEXT;
  target_model TEXT;
  consumer_owner TEXT;
  provider_model TEXT;
  provider_account TEXT;
  provider_upstream_model TEXT;
  provider_endpoint_identity TEXT;
  provider_endpoint_version INTEGER;
  pool_owner TEXT;
  token_owner TEXT;
BEGIN
  IF TG_TABLE_NAME = 'pool_member' THEN
    IF NEW."executionTargetId" IS NULL THEN
      IF NEW."discoveredModelId" IS NULL THEN
        RAISE EXCEPTION 'pool_member requires an execution target or legacy discovered model'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    SELECT et."userId", et."discoveredModelId", pool."userId"
      INTO target_owner, target_model, consumer_owner
      FROM execution_target et, model_pool pool
     WHERE et.id = NEW."executionTargetId" AND pool.id = NEW."poolId";
    IF target_owner IS NULL OR target_owner <> consumer_owner
       OR (NEW."discoveredModelId" IS NOT NULL
           AND target_model IS DISTINCT FROM NEW."discoveredModelId") THEN
      RAISE EXCEPTION 'pool_member execution target must match its owner and discovered model'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'model_api_token_allowlist_entry' THEN
    IF NEW."executionTargetId" IS NULL THEN
      IF NEW.target = 'DIRECT_MODEL'::"ModelApiTokenAllowlistTarget"
         AND NEW."discoveredModelId" IS NULL THEN
        RAISE EXCEPTION 'direct-model allowlist entry requires an execution target or legacy model'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;
    SELECT et."userId", et."discoveredModelId", token."userId"
      INTO target_owner, target_model, consumer_owner
      FROM execution_target et, model_api_token token
     WHERE et.id = NEW."executionTargetId" AND token.id = NEW."modelApiTokenId";
    IF NEW.target <> 'DIRECT_MODEL'::"ModelApiTokenAllowlistTarget"
       OR target_owner IS NULL
       OR target_owner <> consumer_owner
       OR (NEW."discoveredModelId" IS NOT NULL
           AND target_model IS DISTINCT FROM NEW."discoveredModelId") THEN
      RAISE EXCEPTION 'allowlist execution target must match its owner and direct model'
        USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'response_stickiness_record' THEN
    IF NEW."routingVersion" >= 3 THEN
      SELECT et."userId", et."providerModelId", model."providerAccountId",
             model."upstreamModelId", acct."endpointIdentity", acct."endpointVersion",
             pool."userId"
        INTO target_owner, provider_model, provider_account, provider_upstream_model,
             provider_endpoint_identity, provider_endpoint_version, pool_owner
        FROM execution_target et
        JOIN provider_model model ON model.id = et."providerModelId"
        JOIN provider_account acct ON acct.id = model."providerAccountId"
        JOIN model_pool pool ON pool.id = NEW."targetModelPoolId"
       WHERE et.id = NEW."selectedExecutionTargetId";
      IF target_owner IS NULL
         OR provider_model IS DISTINCT FROM NEW."providerModelId"
         OR provider_account IS DISTINCT FROM NEW."providerAccountId"
         OR provider_upstream_model IS DISTINCT FROM NEW."providerUpstreamModelId"
         OR provider_endpoint_identity IS DISTINCT FROM NEW."providerEndpointIdentity"
         OR provider_endpoint_version IS DISTINCT FROM NEW."providerEndpointVersion"
         OR (NEW."fallbackRoute" = 'own-key' AND (
           target_owner IS DISTINCT FROM NEW."userId"
           OR pool_owner IS NOT DISTINCT FROM NEW."userId"
           OR NEW."poolGrantId" IS NULL))
         OR (NEW."fallbackRoute" IS DISTINCT FROM 'own-key' AND (
         pool_owner IS DISTINCT FROM target_owner
         OR NOT EXISTS (
           SELECT 1 FROM pool_member member
            WHERE member."poolId" = NEW."targetModelPoolId"
              AND member."executionTargetId" = NEW."selectedExecutionTargetId"
              AND member.tier IN (
                'PRIMARY'::"PoolMemberTier",
                'PUBLIC_OVERFLOW'::"PoolMemberTier"
              )
         )))
         OR (NEW."userId" IS NOT DISTINCT FROM pool_owner AND NEW."poolGrantId" IS NOT NULL)
         OR (NEW."userId" IS DISTINCT FROM pool_owner AND (
           NEW."poolGrantId" IS NULL OR NOT EXISTS (
             SELECT 1 FROM pool_grant grant_row
              WHERE grant_row.id = NEW."poolGrantId"
                AND grant_row."poolId" = NEW."targetModelPoolId"
                AND grant_row."ownerUserId" = pool_owner
                AND grant_row."granteeUserId" = NEW."userId"
           )
         )) THEN
        RAISE EXCEPTION 'provider stickiness binding must match its exact account, model, target, pool, endpoint, and visibility graph'
          USING ERRCODE = '23514';
      END IF;
      -- Whether the owner still allows external fallback is a runtime gate
      -- (checked on every follow-up), not a binding-write invariant.
      IF NEW."modelApiTokenId" IS NOT NULL THEN
        SELECT "userId" INTO token_owner FROM model_api_token
         WHERE id = NEW."modelApiTokenId";
        IF token_owner IS NULL OR token_owner IS DISTINCT FROM NEW."userId" THEN
          RAISE EXCEPTION 'provider stickiness token must belong to its requester'
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    -- Local (v1/v2) bindings. A pool binding belongs to the pool owner's
    -- graph, like a pool relay_request: the requester is the owner (no grant)
    -- or holds the exact grant, whose deletion cascades the binding away.
    -- Without a pool the binding is direct and the requester owns the target.
    -- These are write-time rules. An UPDATE that changes no identity column
    -- and at most clears a reference (such as the SET NULL action of a
    -- deleted discovered model while the pool owner's whole account is
    -- deleted in one cascade, after its pool and grant rows are gone)
    -- authorizes nothing new, so it is not re-checked.
    IF TG_OP = 'UPDATE'
       AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
       AND NEW."routingVersion" IS NOT DISTINCT FROM OLD."routingVersion"
       AND NEW."targetModelPoolId" IS NOT DISTINCT FROM OLD."targetModelPoolId"
       AND NEW."poolGrantId" IS NOT DISTINCT FROM OLD."poolGrantId"
       AND (NEW."targetExecutionTargetId" IS NULL
            OR NEW."targetExecutionTargetId" IS NOT DISTINCT FROM OLD."targetExecutionTargetId")
       AND (NEW."targetDiscoveredModelId" IS NULL
            OR NEW."targetDiscoveredModelId" IS NOT DISTINCT FROM OLD."targetDiscoveredModelId")
       AND (NEW."selectedExecutionTargetId" IS NULL
            OR NEW."selectedExecutionTargetId" IS NOT DISTINCT FROM OLD."selectedExecutionTargetId")
       AND (NEW."selectedDiscoveredModelId" IS NULL
            OR NEW."selectedDiscoveredModelId" IS NOT DISTINCT FROM OLD."selectedDiscoveredModelId") THEN
      RETURN NEW;
    END IF;
    consumer_owner := NEW."userId";
    IF NEW."targetModelPoolId" IS NOT NULL THEN
      -- A binding targets a pool or a direct model, never both: routing
      -- would take the direct branch and skip the pool's checks.
      IF NEW."targetExecutionTargetId" IS NOT NULL OR NEW."targetDiscoveredModelId" IS NOT NULL THEN
        RAISE EXCEPTION 'stickiness binding targets either a pool or a direct model'
          USING ERRCODE = '23514';
      END IF;
      SELECT "userId" INTO pool_owner FROM model_pool WHERE id = NEW."targetModelPoolId";
      IF pool_owner IS NULL
         OR (NEW."poolGrantId" IS NULL AND pool_owner IS DISTINCT FROM NEW."userId")
         OR (NEW."poolGrantId" IS NOT NULL AND (
           pool_owner IS NOT DISTINCT FROM NEW."userId"
           OR NOT EXISTS (
             SELECT 1 FROM pool_grant grant_row
              WHERE grant_row.id = NEW."poolGrantId"
                AND grant_row."poolId" = NEW."targetModelPoolId"
                AND grant_row."ownerUserId" = pool_owner
                AND grant_row."granteeUserId" = NEW."userId"))) THEN
        RAISE EXCEPTION 'stickiness pool binding requires the pool owner or the exact grant'
          USING ERRCODE = '23514';
      END IF;
      consumer_owner := pool_owner;
    ELSIF NEW."poolGrantId" IS NOT NULL THEN
      RAISE EXCEPTION 'stickiness pool binding requires the pool owner or the exact grant'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."targetExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."targetExecutionTargetId";
      IF target_owner IS NULL OR target_owner <> NEW."userId"
         OR (NEW."targetDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."targetDiscoveredModelId") THEN
        RAISE EXCEPTION 'stickiness target must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."selectedExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."selectedExecutionTargetId";
      IF target_owner IS NULL OR target_owner IS DISTINCT FROM consumer_owner
         OR (NEW."selectedDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."selectedDiscoveredModelId") THEN
        RAISE EXCEPTION 'stickiness selection must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
      -- The served member must be a local member of the pool when the
      -- selection is written. Membership is mutable, so unchanged historical
      -- rows are not re-checked; follow-up routing re-checks it live.
      IF NEW."targetModelPoolId" IS NOT NULL
         AND (TG_OP = 'INSERT'
           OR NEW."selectedExecutionTargetId" IS DISTINCT FROM OLD."selectedExecutionTargetId"
           OR NEW."targetModelPoolId" IS DISTINCT FROM OLD."targetModelPoolId")
         AND NOT EXISTS (
           SELECT 1 FROM pool_member member
            WHERE member."poolId" = NEW."targetModelPoolId"
              AND member."executionTargetId" = NEW."selectedExecutionTargetId"
              AND member.tier = 'PRIMARY'::"PoolMemberTier") THEN
        RAISE EXCEPTION 'stickiness selection must be a local member of its pool'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'relay_request' THEN
    -- relay_request is hot-path history (DL-1 design (d), #78): it names its
    -- pool, targets and member by plain id and keeps them after they are
    -- deleted. A live parent is always checked; a deleted one is not (the
    -- request's late finalizer must still commit its status and counters).
    -- Readers fail closed on a deleted parent: they expose an owner's
    -- target/member/capacity identities only to that owner.
    IF NEW."requestedExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."requestedExecutionTargetId";
      IF FOUND AND (target_owner IS DISTINCT FROM NEW."userId"
         OR (NEW."requestedDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."requestedDiscoveredModelId")) THEN
        RAISE EXCEPTION 'relay request target must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    -- A PENDING pool request whose pool is already gone (deleted while the
    -- request was in flight) keeps its durable resource owner but no
    -- ownership anchor. Its late finalizer, which re-writes the pool owner's
    -- selection (route identity, pool member), must still commit its status
    -- and counters, so that selection is dropped, never persisted. A terminal
    -- row, and a target of anyone else, are still rejected below.
    -- resourceOwnerUserId is derived and pinned by
    -- a_relay_request_resource_owner, which runs before this trigger.
    IF TG_OP = 'UPDATE' AND OLD.status = 'PENDING'
       AND NEW."requestedModelPoolId" IS NULL
       AND OLD."requestedModelPoolId" IS NULL
       AND NEW."resourceOwnerUserId" IS NOT NULL
       AND NEW."resourceOwnerUserId" IS DISTINCT FROM NEW."userId"
       AND NEW."userId" IS NOT DISTINCT FROM OLD."userId"
       AND NEW."fallbackRoute" IS DISTINCT FROM 'own-key'
       AND (NEW."selectedExecutionTargetId" IS NOT NULL OR NEW."selectedPoolMemberId" IS NOT NULL) THEN
      -- A target that no longer exists (deleted with the owner's account or
      -- device) can never be persisted either, so it is dropped the same way.
      target_owner := NULL;
      IF NEW."selectedExecutionTargetId" IS NOT NULL THEN
        SELECT "userId" INTO target_owner
          FROM execution_target WHERE id = NEW."selectedExecutionTargetId";
      END IF;
      IF NEW."selectedExecutionTargetId" IS NULL
         OR target_owner IS NULL
         OR target_owner IS NOT DISTINCT FROM NEW."resourceOwnerUserId" THEN
        NEW."selectedExecutionTargetId" := NULL;
        NEW."selectedDiscoveredModelId" := NULL;
        NEW."selectedPoolMemberId" := NULL;
        RETURN NEW;
      END IF;
    END IF;
    IF NEW."selectedExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."selectedExecutionTargetId";
      IF FOUND THEN
        -- userId is the caller. Local and owner-paid pool targets belong to
        -- the pool owner (the durable resource owner once the pool is gone);
        -- DIRECT and own-key targets belong to the caller. This is
        -- historical identity, not a live-grant authorization check.
        consumer_owner := NEW."userId";
        IF NEW."requestedModelPoolId" IS NOT NULL AND NEW."fallbackRoute" IS DISTINCT FROM 'own-key' THEN
          SELECT "userId" INTO pool_owner FROM model_pool WHERE id = NEW."requestedModelPoolId";
          consumer_owner := COALESCE(pool_owner, NEW."resourceOwnerUserId");
        END IF;
        IF target_owner IS DISTINCT FROM consumer_owner
           OR (NEW."selectedDiscoveredModelId" IS NOT NULL
               AND target_model IS DISTINCT FROM NEW."selectedDiscoveredModelId") THEN
          RAISE EXCEPTION 'relay request selection must match its owner and discovered model'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$consumer_check$;

DROP TRIGGER IF EXISTS pool_member_execution_target_consistency ON pool_member;
CREATE TRIGGER pool_member_execution_target_consistency
BEFORE INSERT OR UPDATE OF "poolId", "discoveredModelId", "executionTargetId" ON pool_member
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

DROP TRIGGER IF EXISTS allowlist_execution_target_consistency ON model_api_token_allowlist_entry;
CREATE TRIGGER allowlist_execution_target_consistency
BEFORE INSERT OR UPDATE OF "modelApiTokenId", target, "discoveredModelId", "executionTargetId"
ON model_api_token_allowlist_entry
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

DROP TRIGGER IF EXISTS stickiness_execution_target_consistency ON response_stickiness_record;
CREATE TRIGGER stickiness_execution_target_consistency
BEFORE INSERT OR UPDATE OF "userId", "targetDiscoveredModelId", "targetExecutionTargetId",
  "selectedDiscoveredModelId", "selectedExecutionTargetId", "targetModelPoolId", "poolGrantId",
  "routingVersion" ON response_stickiness_record
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

-- Durable usage attribution for relay requests (#66, P3C-2). Derived here,
-- never trusted from the writer: the requested pool's owner, else the
-- requester (a direct target must belong to the requester). Pinned once set,
-- so the pool's deletion (the pool id then dangles) keeps the owner; only
-- attaching a different live pool re-derives it. A plain id, like every
-- graph reference of relay_request: rollup writers skip an owner that no
-- longer exists.
CREATE OR REPLACE FUNCTION derive_relay_request_resource_owner()
RETURNS trigger LANGUAGE plpgsql AS $relay_resource_owner$
DECLARE
  pool_owner TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."resourceOwnerUserId" IS NOT NULL
     AND (NEW."requestedModelPoolId" IS NULL
       OR NEW."requestedModelPoolId" IS NOT DISTINCT FROM OLD."requestedModelPoolId") THEN
    NEW."resourceOwnerUserId" := OLD."resourceOwnerUserId";
    RETURN NEW;
  END IF;
  IF NEW."requestedModelPoolId" IS NOT NULL THEN
    SELECT "userId" INTO pool_owner FROM model_pool WHERE id = NEW."requestedModelPoolId";
  END IF;
  NEW."resourceOwnerUserId" := COALESCE(
    pool_owner,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD."resourceOwnerUserId" END,
    NEW."userId"
  );
  RETURN NEW;
END;
$relay_resource_owner$;

DROP TRIGGER IF EXISTS a_relay_request_resource_owner ON relay_request;
CREATE TRIGGER a_relay_request_resource_owner
BEFORE INSERT OR UPDATE OF "requestedModelPoolId", "resourceOwnerUserId" ON relay_request
FOR EACH ROW EXECUTE FUNCTION derive_relay_request_resource_owner();

-- One-time backfill (a no-op once applied; writes no status). Rows whose pool
-- is already gone fall back to the requester, as their rollup already did.
UPDATE relay_request AS request
   SET "resourceOwnerUserId" = COALESCE(
         (SELECT pool."userId" FROM model_pool pool WHERE pool.id = request."requestedModelPoolId"),
         request."userId")
 WHERE request."resourceOwnerUserId" IS NULL;

DROP TRIGGER IF EXISTS relay_request_execution_target_consistency ON relay_request;
CREATE TRIGGER relay_request_execution_target_consistency
BEFORE INSERT OR UPDATE OF "userId", "requestedDiscoveredModelId", "requestedExecutionTargetId",
  "selectedDiscoveredModelId", "selectedExecutionTargetId", "requestedModelPoolId", "fallbackRoute" ON relay_request
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

UPDATE provider_account SET "endpointIdentity" = "baseUrl" WHERE "endpointIdentity" = '';

-- Fencing counters are monotonic non-negative watermarks. Repair legacy or
-- partially-applied rows before installing the checks, and retain any live
-- half-open owner's token in the durable health watermark.
UPDATE provider_account
   SET "nextFencingToken" = GREATEST(
         "nextFencingToken",
         "healthFencingWatermark",
         COALESCE("healthHalfOpenFencingToken", 0),
         0
       ),
       "healthFencingWatermark" = GREATEST(
         "healthFencingWatermark",
         COALESCE("healthHalfOpenFencingToken", 0)
       )
 WHERE "nextFencingToken" < GREATEST(
         "healthFencingWatermark",
         COALESCE("healthHalfOpenFencingToken", 0),
         0
       )
    OR "healthFencingWatermark" < COALESCE("healthHalfOpenFencingToken", 0);
UPDATE provider_model
   SET "healthFencingWatermark" = GREATEST(
         "healthFencingWatermark",
         COALESCE("healthHalfOpenFencingToken", 0)
       )
 WHERE "healthFencingWatermark" < COALESCE("healthHalfOpenFencingToken", 0);

-- Pre-ownership half-open timestamps cannot safely identify a live worker.
-- Clear them during the compatibility cutover; an expired cooldown can then
-- be reclaimed immediately by a fenced writer.
UPDATE provider_account
   SET "healthHalfOpenAt" = NULL
 WHERE "healthHalfOpenAt" IS NOT NULL
   AND "healthHalfOpenAttemptId" IS NULL;
UPDATE provider_model
   SET "healthHalfOpenAt" = NULL
 WHERE "healthHalfOpenAt" IS NOT NULL
   AND "healthHalfOpenAttemptId" IS NULL;

ALTER TABLE provider_account DROP CONSTRAINT IF EXISTS provider_account_shape_check;
ALTER TABLE provider_account ADD CONSTRAINT provider_account_shape_check CHECK (
  "providerType" = lower("providerType")
  AND "providerType" ~ '^[a-z][a-z0-9_-]{0,63}$'
  AND btrim(label) <> ''
  AND btrim("baseUrl") <> ''
  AND btrim("endpointIdentity") <> ''
  AND "endpointVersion" > 0
  AND "nextFencingToken" >= 0
  AND "healthFencingWatermark" >= 0
  AND "nextFencingToken" >= "healthFencingWatermark"
  AND "healthFencingWatermark" >= COALESCE("healthHalfOpenFencingToken", 0)
  AND (enabled = FALSE OR status = 'ACTIVE')
  AND (enabled = FALSE OR "currentCredentialId" IS NOT NULL)
  AND (("healthHalfOpenAt" IS NULL AND "healthHalfOpenAttemptId" IS NULL AND "healthHalfOpenFencingToken" IS NULL)
    OR ("healthHalfOpenAt" IS NOT NULL AND btrim("healthHalfOpenAttemptId") <> '' AND "healthHalfOpenFencingToken" > 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_credential_one_active_per_account
  ON provider_credential ("providerAccountId") WHERE status = 'ACTIVE';

ALTER TABLE provider_model DROP CONSTRAINT IF EXISTS provider_model_shape_check;
ALTER TABLE provider_model ADD CONSTRAINT provider_model_shape_check CHECK (
  btrim("upstreamModelId") <> ''
  AND ("contextWindow" IS NULL OR "contextWindow" > 0)
  AND ("maxOutputTokens" IS NULL OR "maxOutputTokens" > 0)
  AND ("concurrencyLimit" IS NULL OR "concurrencyLimit" > 0)
  AND ("pricingVersion" IS NULL OR btrim("pricingVersion") <> '')
  AND "healthFencingWatermark" >= 0
  AND "healthFencingWatermark" >= COALESCE("healthHalfOpenFencingToken", 0)
  AND (("healthHalfOpenAt" IS NULL AND "healthHalfOpenAttemptId" IS NULL AND "healthHalfOpenFencingToken" IS NULL)
    OR ("healthHalfOpenAt" IS NOT NULL AND btrim("healthHalfOpenAttemptId") <> '' AND "healthHalfOpenFencingToken" > 0))
);

ALTER TABLE provider_credential DROP CONSTRAINT IF EXISTS provider_credential_shape_check;
ALTER TABLE provider_credential ADD CONSTRAINT provider_credential_shape_check CHECK (
  "aadVersion" > 0
  AND algorithm = 'AES-256-GCM'
  AND octet_length(nonce) = 12
  AND octet_length("authTag") = 16
  AND octet_length(ciphertext) > 0
  AND btrim("keyVersion") <> ''
  AND char_length("displaySuffix") BETWEEN 1 AND 4
  AND ((status = 'ACTIVE' AND "replacedAt" IS NULL AND "revokedAt" IS NULL)
    OR (status = 'REPLACED' AND "replacedAt" IS NOT NULL AND "replacedById" IS NOT NULL AND "revokedAt" IS NULL)
    OR (status = 'REVOKED' AND "revokedAt" IS NOT NULL))
);

ALTER TABLE provider_budget_policy DROP CONSTRAINT IF EXISTS provider_budget_policy_scope_check;
ALTER TABLE provider_budget_policy ADD CONSTRAINT provider_budget_policy_scope_check CHECK (
  version > 0
  AND (("scopeType" = 'PROVIDER_ACCOUNT' AND "poolId" IS NULL AND "providerModelId" IS NULL)
    OR ("scopeType" = 'POOL_PROVIDER_MODEL' AND "poolId" IS NOT NULL AND "providerModelId" IS NOT NULL))
  AND ((active AND "activatedAt" IS NOT NULL AND "deactivatedAt" IS NULL)
    OR (NOT active AND ("activatedAt" IS NULL OR "deactivatedAt" IS NOT NULL)))
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_policy_account_version_unique
  ON provider_budget_policy ("userId", "providerAccountId", version)
  WHERE "scopeType" = 'PROVIDER_ACCOUNT';
CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_policy_attachment_version_unique
  ON provider_budget_policy ("userId", "providerAccountId", "poolId", "providerModelId", version)
  WHERE "scopeType" = 'POOL_PROVIDER_MODEL';
CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_policy_one_active_account
  ON provider_budget_policy ("userId", "providerAccountId")
  WHERE active AND "scopeType" = 'PROVIDER_ACCOUNT';
CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_policy_one_active_attachment
  ON provider_budget_policy ("userId", "providerAccountId", "poolId", "providerModelId")
  WHERE active AND "scopeType" = 'POOL_PROVIDER_MODEL';

ALTER TABLE provider_budget_rule DROP CONSTRAINT IF EXISTS provider_budget_rule_shape_check;
ALTER TABLE provider_budget_rule ADD CONSTRAINT provider_budget_rule_shape_check CHECK (
  ((mode = 'LIMITED' AND "limitValue" > 0) OR (mode = 'UNLIMITED' AND "limitValue" IS NULL))
  AND ((metric = 'SPEND' AND currency ~ '^[A-Z]{3}$') OR (metric <> 'SPEND' AND currency IS NULL))
  AND (metric <> 'CONCURRENCY' OR period = 'PER_ATTEMPT')
  AND (metric <> 'SPEND' OR period IN ('UTC_DAY', 'UTC_MONTH'))
  AND (metric = 'SPEND' OR "limitValue" IS NULL OR trunc("limitValue") = "limitValue")
);

ALTER TABLE provider_budget_reservation DROP CONSTRAINT IF EXISTS provider_budget_reservation_shape_check;
ALTER TABLE provider_budget_reservation ADD CONSTRAINT provider_budget_reservation_shape_check CHECK (
  "fencingToken" > 0 AND "policyVersion" > 0 AND "reservedValue" > 0
  AND btrim("providerAccountId") <> '' AND btrim("providerModelId") <> ''
  AND btrim("requestId") <> '' AND btrim("attemptId") <> ''
  AND btrim("accountingVersion") <> ''
  AND ("pricingVersion" IS NULL OR btrim("pricingVersion") <> '')
  AND ("liabilityTokens" IS NULL OR "liabilityTokens" >= 0)
  AND ("liabilitySpend" IS NULL OR "liabilitySpend" >= 0)
  AND ("liabilityCurrency" IS NULL OR "liabilityCurrency" ~ '^[A-Z]{3}$')
  AND "utcBasis" = 'UTC'
  AND ((period = 'LIFETIME' AND "windowStart" IS NOT NULL AND "windowEnd" IS NULL)
    OR (period = 'PER_ATTEMPT' AND "windowStart" IS NULL AND "windowEnd" IS NULL)
    OR (period IN ('UTC_DAY', 'UTC_MONTH') AND "windowStart" IS NOT NULL AND "windowEnd" > "windowStart"))
  AND ((metric = 'SPEND' AND currency ~ '^[A-Z]{3}$') OR (metric <> 'SPEND' AND currency IS NULL))
  AND ("settledValue" IS NULL OR "settledValue" >= 0)
);

-- Prisma creates provider_attempt before this script runs. Populate anchors for
-- reservations written by the previous release before enforcing the new graph.
-- Cost identity is retained only when the complete pricing triple existed;
-- partial legacy metadata remains intact on the reservation itself.
INSERT INTO provider_attempt (
  id, "createdAt", "userId", "providerAccountId", "providerModelId", "credentialId",
  "poolId", "requestId", "attemptId", "fencingToken", "expiresAt", "liabilityTokens",
  "liabilitySpend", "liabilityCurrency", "pricingVersion", "accountingVersion"
)
SELECT DISTINCT ON (r."attemptId", r."fencingToken")
  'legacy-' || md5(r."attemptId" || ':' || r."fencingToken"::text), r."createdAt", r."userId",
  r."providerAccountId", r."providerModelId", r."credentialId", r."poolId", r."requestId",
  r."attemptId", r."fencingToken",
  GREATEST(COALESCE(r."expiresAt", r."createdAt" + interval '24 hours'),
           r."createdAt" + interval '1 millisecond'),
  r."liabilityTokens",
  CASE WHEN r."liabilitySpend" IS NOT NULL AND r."liabilityCurrency" IS NOT NULL
         AND r."pricingVersion" IS NOT NULL THEN r."liabilitySpend" END,
  CASE WHEN r."liabilitySpend" IS NOT NULL AND r."liabilityCurrency" IS NOT NULL
         AND r."pricingVersion" IS NOT NULL THEN r."liabilityCurrency" END,
  CASE WHEN r."liabilitySpend" IS NOT NULL AND r."liabilityCurrency" IS NOT NULL
         AND r."pricingVersion" IS NOT NULL THEN r."pricingVersion" END,
  r."accountingVersion"
FROM provider_budget_reservation r
ON CONFLICT ("attemptId", "fencingToken") DO NOTHING;

ALTER TABLE provider_attempt DROP CONSTRAINT IF EXISTS provider_attempt_shape_check;
ALTER TABLE provider_attempt ADD CONSTRAINT provider_attempt_shape_check CHECK (
  "fencingToken" > 0 AND "expiresAt" > "createdAt"
  AND btrim("requestId") <> '' AND btrim("attemptId") <> ''
  AND btrim("accountingVersion") <> ''
  AND ("liabilityTokens" IS NULL OR "liabilityTokens" >= 0)
  AND ("liabilitySpend" IS NULL OR "liabilitySpend" >= 0)
  AND ("liabilityCurrency" IS NULL OR "liabilityCurrency" ~ '^[A-Z]{3}$')
  AND ("pricingVersion" IS NULL OR btrim("pricingVersion") <> '')
  AND (("liabilitySpend" IS NULL AND "liabilityCurrency" IS NULL AND "pricingVersion" IS NULL)
    OR ("liabilitySpend" IS NOT NULL AND "liabilityCurrency" IS NOT NULL AND "pricingVersion" IS NOT NULL))
);

-- Backfill ordered immutable revisions introduced after the first terminal-only
-- ledger release. Arrival order is used only for legacy rows; all new writers
-- must provide an explicit provider sequence.
-- A previous release may already have installed the append-only triggers. Drop
-- exactly the two triggers protecting rows this compatibility block rewrites;
-- the surrounding transaction restores the old definitions automatically on
-- failure, and recreates them below before commit.
DROP TRIGGER IF EXISTS provider_usage_ledger_immutable ON provider_usage_ledger;
DROP TRIGGER IF EXISTS provider_budget_settlement_immutable ON provider_budget_settlement;

WITH ordered AS (
  SELECT id, row_number() OVER (
    PARTITION BY "attemptId", "fencingToken" ORDER BY "createdAt", id
  )::bigint AS sequence
  FROM provider_usage_ledger
)
UPDATE provider_usage_ledger ledger
   SET "revisionSequence" = ordered.sequence,
       "payloadHash" = CASE WHEN ledger."payloadHash" = 'legacy-pending'
         THEN md5(to_jsonb(ledger)::text) ELSE ledger."payloadHash" END
  FROM ordered
 WHERE ordered.id = ledger.id
   AND ledger."payloadHash" = 'legacy-pending';

-- Older revisions retained only the admitted accounting contract. Preserve a
-- deterministic source identity for observations that demonstrably contained
-- usage; crash/empty observations continue to have no source usage contract.
UPDATE provider_usage_ledger
   SET "sourceUsageAccountingVersion" = "accountingVersion"
 WHERE "sourceUsageAccountingVersion" IS NULL
   AND ("inputTokens" IS NOT NULL OR "outputTokens" IS NOT NULL
     OR "cacheReadTokens" IS NOT NULL OR "cacheWriteTokens" IS NOT NULL
     OR "reasoningTokens" IS NOT NULL OR "toolTokens" IS NOT NULL
     OR "additionalBillableTokens" IS NOT NULL OR "authoritativeBillableTokens" IS NOT NULL
     OR "billableTotal" IS NOT NULL OR "rawUsage" IS NOT NULL
     OR "reportedCost" IS NOT NULL OR "calculatedCost" IS NOT NULL);

UPDATE provider_budget_settlement settlement
   SET "providerAccountId" = attempt."providerAccountId",
       "providerModelId" = attempt."providerModelId",
       "credentialId" = attempt."credentialId",
       "poolId" = attempt."poolId",
       "requestId" = attempt."requestId",
       "accountingVersion" = attempt."accountingVersion",
       "sourceUsageAccountingVersion" = ledger."sourceUsageAccountingVersion",
       "pricingVersion" = attempt."pricingVersion",
       "revisionSequence" = ledger."revisionSequence",
       "revisionKind" = ledger."revisionKind",
       "payloadHash" = CASE WHEN settlement."payloadHash" = 'legacy-pending'
         THEN ledger."payloadHash" ELSE settlement."payloadHash" END
  FROM provider_attempt attempt, provider_usage_ledger ledger
 WHERE settlement."attemptId" = attempt."attemptId"
   AND settlement."fencingToken" = attempt."fencingToken"
   AND ledger."attemptId" = attempt."attemptId"
   AND ledger."fencingToken" = attempt."fencingToken"
   AND ledger."sourceVersion" = settlement."sourceVersion"
   AND (settlement."providerAccountId" = '' OR settlement."providerModelId" = ''
     OR settlement."requestId" = '' OR settlement."accountingVersion" = ''
     OR settlement."sourceUsageAccountingVersion" IS DISTINCT FROM ledger."sourceUsageAccountingVersion"
     OR settlement."payloadHash" = 'legacy-pending'
     OR settlement."revisionSequence" IS DISTINCT FROM ledger."revisionSequence"
     OR settlement."revisionKind" IS DISTINCT FROM ledger."revisionKind");

CREATE UNIQUE INDEX IF NOT EXISTS provider_usage_ledger_attempt_revision_unique
  ON provider_usage_ledger ("attemptId", "fencingToken", "revisionSequence");
CREATE UNIQUE INDEX IF NOT EXISTS provider_budget_settlement_reservation_revision_unique
  ON provider_budget_settlement ("reservationId", "attemptId", "fencingToken", "revisionSequence");

-- Rows created before observationComplete was persisted already passed the
-- then-current known-usage/cost invariants. Preserve that immutable accounting
-- decision explicitly; unknown/conservative legacy rows remain NULL.
DROP TRIGGER IF EXISTS provider_usage_ledger_immutable ON provider_usage_ledger;
UPDATE provider_usage_ledger
   SET "observationComplete" = TRUE
 WHERE "observationComplete" IS NULL
   AND ("usageKnown" OR "costKnown");

-- Close the legacy split reconcile/finalize crash gap from deployments that
-- committed an immutable terminal ledger before updating its attempt anchor.
-- An older runtime may already have swept the split-phase orphan to EXPIRED.
-- Temporarily remove the transition trigger for this narrowly keyed repair;
-- the canonical trigger is recreated later in this same transaction.
DROP TRIGGER IF EXISTS provider_attempt_transition ON provider_attempt;
WITH latest_terminal AS (
  SELECT DISTINCT ON ("attemptId", "fencingToken")
         "attemptId", "fencingToken", "terminalReason", "createdAt"
    FROM provider_usage_ledger
   ORDER BY "attemptId", "fencingToken", "revisionSequence" DESC, "createdAt" DESC
)
UPDATE provider_attempt attempt
   SET state = CASE
         WHEN latest."terminalReason" = 'COMPLETED' THEN 'COMPLETED'::"ProviderAttemptState"
         WHEN latest."terminalReason" = 'CANCELLED' THEN 'CANCELLED'::"ProviderAttemptState"
         WHEN latest."terminalReason" = 'CRASH_RECOVERY' THEN 'EXPIRED'::"ProviderAttemptState"
         ELSE 'FAILED'::"ProviderAttemptState"
       END,
       "terminalReason" = latest."terminalReason",
       "terminalAt" = latest."createdAt",
       "heartbeatAt" = GREATEST(attempt."heartbeatAt", latest."createdAt")
  FROM latest_terminal latest
 WHERE (attempt.state = 'ACTIVE'
        OR (attempt.state = 'EXPIRED' AND attempt."terminalReason" = 'CRASH_RECOVERY'
            AND latest."terminalReason" <> 'CRASH_RECOVERY'))
   AND latest."attemptId" = attempt."attemptId"
   AND latest."fencingToken" = attempt."fencingToken";

ALTER TABLE provider_usage_ledger DROP CONSTRAINT IF EXISTS provider_usage_ledger_shape_check;
ALTER TABLE provider_usage_ledger ADD CONSTRAINT provider_usage_ledger_shape_check CHECK (
  "fencingToken" > 0 AND ("settledCost" IS NULL OR "settledCost" >= 0)
  AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')
  AND ("pricingVersion" IS NULL OR btrim("pricingVersion") <> '')
  AND btrim("accountingVersion") <> '' AND btrim("terminalReason") <> ''
  AND ("sourceUsageAccountingVersion" IS NULL OR btrim("sourceUsageAccountingVersion") <> '')
  AND (NOT "costKnown" OR ("settledCost" IS NOT NULL AND currency IS NOT NULL AND "pricingVersion" IS NOT NULL))
  AND (NOT "costKnown" OR "observationComplete" IS TRUE)
  AND (NOT "usageKnown" OR "observationComplete" IS TRUE)
  AND ("reportedCost" IS NULL OR "reportedCost" >= 0)
  AND ("reportedCostCurrency" IS NULL OR "reportedCostCurrency" ~ '^[A-Z]{3}$')
  AND ("reportedCostPricingVersion" IS NULL OR btrim("reportedCostPricingVersion") <> '')
  AND ("reportedCostSource" IS NULL OR btrim("reportedCostSource") <> '')
  AND ("calculatedCost" IS NULL OR "calculatedCost" >= 0)
  AND ("calculatedCostCurrency" IS NULL OR "calculatedCostCurrency" ~ '^[A-Z]{3}$')
  AND ("calculatedCostPricingVersion" IS NULL OR btrim("calculatedCostPricingVersion") <> '')
  AND ("calculatedCostSource" IS NULL OR btrim("calculatedCostSource") <> '')
  AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
  AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
  AND ("cacheReadTokens" IS NULL OR "cacheReadTokens" >= 0)
  AND ("cacheWriteTokens" IS NULL OR "cacheWriteTokens" >= 0)
  AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
  AND ("toolTokens" IS NULL OR "toolTokens" >= 0)
  AND ("additionalBillableTokens" IS NULL OR "additionalBillableTokens" >= 0)
  AND ("authoritativeBillableTokens" IS NULL OR "authoritativeBillableTokens" >= 0)
  AND ("reportedTotalTokens" IS NULL OR "reportedTotalTokens" >= 0)
  AND ("billableTotal" IS NULL OR "billableTotal" >= 0)
  AND btrim("sourceVersion") <> '' AND btrim("usageSource") <> ''
  AND "revisionSequence" >= 0 AND btrim("payloadHash") <> ''
);

-- Rows created before pricing lifecycle fields existed were effective schedules,
-- not drafts. Prisma's ACTIVE/activatedAt defaults preserve that meaning; this
-- idempotent correction maps legacy rows that already had an end boundary.
UPDATE provider_pricing_version
SET status = 'RETIRED'
WHERE status = 'ACTIVE' AND "retiredAt" IS NOT NULL;

ALTER TABLE provider_pricing_version DROP CONSTRAINT IF EXISTS provider_pricing_version_shape_check;
ALTER TABLE provider_pricing_version ADD CONSTRAINT provider_pricing_version_shape_check CHECK (
  btrim(version) <> '' AND currency ~ '^[A-Z]{3}$'
  AND btrim("accountingVersion") <> ''
  AND jsonb_typeof(pricing) = 'object' AND jsonb_typeof("chargeRules") = 'object'
  AND ((status = 'DRAFT' AND "activatedAt" IS NULL AND "retiredAt" IS NULL)
    OR (status = 'ACTIVE' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NULL)
    OR (status = 'RETIRED' AND "activatedAt" IS NOT NULL AND "retiredAt" IS NOT NULL))
  AND ("retiredAt" IS NULL OR "retiredAt" > "effectiveAt")
);

ALTER TABLE provider_budget_settlement DROP CONSTRAINT IF EXISTS provider_budget_settlement_shape_check;
ALTER TABLE provider_budget_settlement ADD CONSTRAINT provider_budget_settlement_shape_check CHECK (
  "fencingToken" > 0 AND btrim(reason) <> '' AND btrim("sourceVersion") <> ''
  AND "revisionSequence" >= 0 AND btrim("payloadHash") <> ''
  AND btrim("providerAccountId") <> '' AND btrim("providerModelId") <> ''
  AND btrim("requestId") <> '' AND btrim("accountingVersion") <> ''
  AND ("sourceUsageAccountingVersion" IS NULL OR btrim("sourceUsageAccountingVersion") <> '')
  AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE OR REPLACE FUNCTION reject_immutable_provider_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $immutable_provider_history$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$immutable_provider_history$;

DROP TRIGGER IF EXISTS provider_usage_ledger_immutable ON provider_usage_ledger;
CREATE TRIGGER provider_usage_ledger_immutable BEFORE UPDATE OR DELETE ON provider_usage_ledger
FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_history_mutation();
CREATE OR REPLACE FUNCTION enforce_provider_pricing_version_immutability()
RETURNS trigger LANGUAGE plpgsql AS $provider_pricing_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'activated provider pricing is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (OLD.status <> 'DRAFT' OR NEW.status <> 'DRAFT') AND
    (OLD."userId", OLD."providerAccountId", OLD."providerModelId", OLD.version,
     OLD.currency, OLD."accountingVersion", OLD.confidence, OLD.pricing,
     OLD."chargeRules", OLD."effectiveAt", OLD."createdAt")
      IS DISTINCT FROM
    (NEW."userId", NEW."providerAccountId", NEW."providerModelId", NEW.version,
     NEW.currency, NEW."accountingVersion", NEW.confidence, NEW.pricing,
     NEW."chargeRules", NEW."effectiveAt", NEW."createdAt") THEN
    RAISE EXCEPTION 'activated provider pricing billing fields are immutable' USING ERRCODE = '55000';
  END IF;
  IF NOT ((OLD.status = NEW.status)
    OR (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE')
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'invalid provider pricing lifecycle transition' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = NEW.status AND
    (OLD."activatedAt", OLD."retiredAt") IS DISTINCT FROM
    (NEW."activatedAt", NEW."retiredAt") THEN
    RAISE EXCEPTION 'provider pricing lifecycle timestamps are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND
    (NEW."activatedAt" IS NULL OR NEW."retiredAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'pricing activation requires exactly one activation timestamp' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED' AND
    (NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR NEW."retiredAt" IS NULL) THEN
    RAISE EXCEPTION 'pricing retirement preserves activation and sets retirement' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_pricing_immutable$;
DROP TRIGGER IF EXISTS provider_pricing_version_immutable ON provider_pricing_version;
CREATE TRIGGER provider_pricing_version_immutable BEFORE UPDATE OR DELETE ON provider_pricing_version
FOR EACH ROW EXECUTE FUNCTION enforce_provider_pricing_version_immutability();
DROP TRIGGER IF EXISTS provider_budget_settlement_immutable ON provider_budget_settlement;
CREATE TRIGGER provider_budget_settlement_immutable BEFORE UPDATE OR DELETE ON provider_budget_settlement
FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_history_mutation();
DROP TRIGGER IF EXISTS provider_attempt_immutable ON provider_attempt;
DROP TRIGGER IF EXISTS provider_attempt_transition ON provider_attempt;
CREATE OR REPLACE FUNCTION enforce_provider_attempt_transition()
RETURNS trigger LANGUAGE plpgsql AS $provider_attempt_transition$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider_attempt is durable history' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW."createdAt", NEW."userId", NEW."providerAccountId", NEW."providerModelId", NEW."credentialId",
         NEW."poolId", NEW."requestId", NEW."attemptId", NEW."fencingToken",
         NEW."liabilityTokens", NEW."liabilitySpend", NEW."liabilityCurrency",
         NEW."pricingVersion", NEW."accountingVersion")
     IS DISTINCT FROM
     ROW(OLD.id, OLD."createdAt", OLD."userId", OLD."providerAccountId", OLD."providerModelId", OLD."credentialId",
         OLD."poolId", OLD."requestId", OLD."attemptId", OLD."fencingToken",
         OLD."liabilityTokens", OLD."liabilitySpend", OLD."liabilityCurrency",
         OLD."pricingVersion", OLD."accountingVersion") THEN
    RAISE EXCEPTION 'provider_attempt identity and liability are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'ACTIVE' THEN
    RAISE EXCEPTION 'invalid provider_attempt terminal transition' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'ACTIVE' THEN
    IF NEW."terminalAt" IS NOT NULL OR NEW."terminalReason" IS NOT NULL
       OR NEW."heartbeatAt" < OLD."heartbeatAt" OR NEW."expiresAt" < NEW."heartbeatAt" THEN
      RAISE EXCEPTION 'invalid active provider_attempt heartbeat' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED')
        OR NEW."terminalAt" IS NULL OR btrim(COALESCE(NEW."terminalReason", '')) = ''
        OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
        OR NEW."heartbeatAt" < OLD."heartbeatAt" THEN
    RAISE EXCEPTION 'invalid provider_attempt terminal fields' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_attempt_transition$;
CREATE TRIGGER provider_attempt_transition BEFORE UPDATE OR DELETE ON provider_attempt
FOR EACH ROW EXECUTE FUNCTION enforce_provider_attempt_transition();

DROP TRIGGER IF EXISTS public_provider_attempt_event_immutable ON public_provider_attempt_event;
CREATE TRIGGER public_provider_attempt_event_immutable BEFORE UPDATE OR DELETE ON public_provider_attempt_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_history_mutation();
DROP TRIGGER IF EXISTS relay_execution_event_immutable ON relay_execution_event;
CREATE TRIGGER relay_execution_event_immutable BEFORE UPDATE ON relay_execution_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_history_mutation();
CREATE OR REPLACE FUNCTION enforce_provider_budget_reservation_transition()
RETURNS trigger LANGUAGE plpgsql AS $provider_budget_reservation_transition$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'provider budget reservations cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'settledValue', 'settledAt']::text[])
      IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state', 'settledValue', 'settledAt']::text[])
     OR OLD.state <> 'RESERVED' OR NEW.state <> 'SETTLED'
     OR NEW."settledValue" IS NULL OR NEW."settledAt" IS NULL THEN
    RAISE EXCEPTION 'provider budget reservation identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_budget_reservation_transition$;
DROP TRIGGER IF EXISTS provider_budget_reservation_transition ON provider_budget_reservation;
CREATE TRIGGER provider_budget_reservation_transition BEFORE UPDATE OR DELETE ON provider_budget_reservation
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_reservation_transition();
DROP TRIGGER IF EXISTS provider_audit_event_immutable ON provider_audit_event;
CREATE TRIGGER provider_audit_event_immutable BEFORE UPDATE OR DELETE ON provider_audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_provider_history_mutation();

CREATE OR REPLACE FUNCTION enforce_provider_credential_immutable_identity()
RETURNS trigger LANGUAGE plpgsql AS $provider_credential_identity$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
     OR NEW."credentialType" IS DISTINCT FROM OLD."credentialType"
     OR NEW."aadVersion" IS DISTINCT FROM OLD."aadVersion" THEN
    RAISE EXCEPTION 'provider credential authenticated identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_credential_identity$;

DROP TRIGGER IF EXISTS provider_credential_identity_immutable ON provider_credential;
CREATE TRIGGER provider_credential_identity_immutable
BEFORE UPDATE OF id, "userId", "providerAccountId", "credentialType", "aadVersion" ON provider_credential
FOR EACH ROW EXECUTE FUNCTION enforce_provider_credential_immutable_identity();

CREATE OR REPLACE FUNCTION enforce_provider_account_endpoint_and_auth()
RETURNS trigger LANGUAGE plpgsql AS $provider_account_endpoint_auth$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."endpointIdentity" IS DISTINCT FROM NEW."baseUrl" OR NEW."endpointVersion" <> 1 THEN
      RAISE EXCEPTION 'provider endpoint identity must start at normalized base URL version 1' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."baseUrl" IS DISTINCT FROM OLD."baseUrl" THEN
    IF NEW."endpointIdentity" IS DISTINCT FROM NEW."baseUrl"
       OR NEW."endpointVersion" <> OLD."endpointVersion" + 1 THEN
      RAISE EXCEPTION 'provider endpoint change must atomically bump its identity version' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."endpointIdentity" IS DISTINCT FROM OLD."endpointIdentity"
     OR NEW."endpointVersion" IS DISTINCT FROM OLD."endpointVersion" THEN
    RAISE EXCEPTION 'provider endpoint identity is immutable without a base URL change' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."authType" IS DISTINCT FROM OLD."authType"
     AND EXISTS (SELECT 1 FROM provider_credential WHERE "providerAccountId" = OLD.id) THEN
    RAISE EXCEPTION 'provider authentication type cannot change after credentials exist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$provider_account_endpoint_auth$;

DROP TRIGGER IF EXISTS provider_account_endpoint_and_auth ON provider_account;
CREATE TRIGGER provider_account_endpoint_and_auth
BEFORE INSERT OR UPDATE OF "baseUrl", "endpointIdentity", "endpointVersion", "authType" ON provider_account
FOR EACH ROW EXECUTE FUNCTION enforce_provider_account_endpoint_and_auth();

CREATE OR REPLACE FUNCTION enforce_provider_graph_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $provider_graph_identity$
BEGIN
  IF TG_TABLE_NAME = 'provider_account' AND
     (NEW.id IS DISTINCT FROM OLD.id OR NEW."userId" IS DISTINCT FROM OLD."userId") THEN
    RAISE EXCEPTION 'provider account identity is immutable' USING ERRCODE = '55000';
  ELSIF TG_TABLE_NAME = 'provider_model' AND
     (NEW.id IS DISTINCT FROM OLD.id OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId") THEN
    RAISE EXCEPTION 'provider model identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_graph_identity$;

DROP TRIGGER IF EXISTS provider_account_identity_immutable ON provider_account;
CREATE TRIGGER provider_account_identity_immutable BEFORE UPDATE OF id, "userId" ON provider_account
FOR EACH ROW EXECUTE FUNCTION enforce_provider_graph_identity_immutable();
DROP TRIGGER IF EXISTS provider_model_identity_immutable ON provider_model;
CREATE TRIGGER provider_model_identity_immutable
BEFORE UPDATE OF id, "userId", "providerAccountId" ON provider_model
FOR EACH ROW EXECUTE FUNCTION enforce_provider_graph_identity_immutable();

CREATE OR REPLACE FUNCTION enforce_provider_credential_account_consistency()
RETURNS trigger LANGUAGE plpgsql AS $provider_credential_account$
DECLARE account_owner TEXT; account_auth TEXT; current_id TEXT; replacement RECORD;
BEGIN
  SELECT "userId", "authType"::text, "currentCredentialId"
    INTO account_owner, account_auth, current_id
    FROM provider_account WHERE id = NEW."providerAccountId";
  IF account_owner IS DISTINCT FROM NEW."userId" OR account_auth IS DISTINCT FROM NEW."credentialType"::text THEN
    RAISE EXCEPTION 'provider credential must match its account owner and authentication type' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ACTIVE' AND current_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'active provider credential must be current for its account' USING ERRCODE = '23514';
  END IF;
  IF NEW."replacedById" IS NOT NULL THEN
    SELECT "userId", "providerAccountId", "credentialType"::text INTO replacement
      FROM provider_credential WHERE id = NEW."replacedById";
    IF replacement."userId" IS DISTINCT FROM NEW."userId"
       OR replacement."providerAccountId" IS DISTINCT FROM NEW."providerAccountId"
       OR replacement."credentialType" IS DISTINCT FROM NEW."credentialType"::text THEN
      RAISE EXCEPTION 'provider credential replacement must stay within its account and authentication type' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$provider_credential_account$;

DROP TRIGGER IF EXISTS provider_credential_account_consistency ON provider_credential;
CREATE CONSTRAINT TRIGGER provider_credential_account_consistency
AFTER INSERT OR UPDATE OF "userId", "providerAccountId", "credentialType", status, "replacedById" ON provider_credential
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_provider_credential_account_consistency();

CREATE OR REPLACE FUNCTION enforce_provider_current_credential_consistency()
RETURNS trigger LANGUAGE plpgsql AS $provider_current_credential$
DECLARE credential_owner TEXT; credential_account TEXT; credential_state TEXT; credential_auth TEXT;
BEGIN
  IF NEW."currentCredentialId" IS NOT NULL THEN
    SELECT "userId", "providerAccountId", status::text, "credentialType"::text
      INTO credential_owner, credential_account, credential_state, credential_auth
      FROM provider_credential WHERE id = NEW."currentCredentialId";
    IF credential_owner IS DISTINCT FROM NEW."userId" OR credential_account IS DISTINCT FROM NEW.id
       OR credential_state IS DISTINCT FROM 'ACTIVE' OR credential_auth IS DISTINCT FROM NEW."authType"::text THEN
      RAISE EXCEPTION 'current provider credential must be active and belong to the account owner' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM provider_credential
     WHERE "providerAccountId" = NEW.id AND "userId" = NEW."userId" AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'provider account without a current credential cannot retain an active credential' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$provider_current_credential$;

DROP TRIGGER IF EXISTS provider_account_current_credential_consistency ON provider_account;
CREATE CONSTRAINT TRIGGER provider_account_current_credential_consistency
AFTER INSERT OR UPDATE OF "currentCredentialId", "userId" ON provider_account
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_provider_current_credential_consistency();

CREATE OR REPLACE FUNCTION enforce_provider_budget_graph_consistency()
RETURNS trigger LANGUAGE plpgsql AS $provider_budget_graph$
DECLARE p RECORD; r RECORD; c RECORD;
BEGIN
  IF TG_TABLE_NAME = 'provider_budget_policy' THEN
    IF NEW."providerModelId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM provider_model m WHERE m.id = NEW."providerModelId"
        AND m."userId" = NEW."userId" AND m."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'budget policy model must belong to its provider account' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_attempt' THEN
    IF NOT EXISTS (SELECT 1 FROM provider_model m WHERE m.id = NEW."providerModelId"
      AND m."userId" = NEW."userId" AND m."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'provider attempt model must match provider account' USING ERRCODE = '23514';
    END IF;
    IF NEW."credentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_credential credential
      WHERE credential.id = NEW."credentialId" AND credential."userId" = NEW."userId"
        AND credential."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'provider attempt credential is inconsistent' USING ERRCODE = '23514';
    END IF;
    IF NEW."poolId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM model_pool mp
      WHERE mp.id = NEW."poolId" AND mp."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'provider attempt pool owner is inconsistent' USING ERRCODE = '23514';
    END IF;
    IF NEW."pricingVersion" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_pricing_version pv
      WHERE pv."providerModelId" = NEW."providerModelId" AND pv.version = NEW."pricingVersion"
        AND pv.currency = NEW."liabilityCurrency" AND pv."providerAccountId" = NEW."providerAccountId"
        AND pv."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'provider attempt pricing identity is inconsistent' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_budget_reservation' THEN
    SELECT * INTO p FROM provider_budget_policy WHERE id = NEW."policyId";
    SELECT * INTO r FROM provider_budget_rule WHERE id = NEW."ruleId";
    IF p.id IS NULL OR r.id IS NULL OR r."policyId" <> p.id
       OR p."userId" <> NEW."userId" OR p.version <> NEW."policyVersion"
       OR r.metric::text <> NEW.metric::text OR r.period::text <> NEW.period::text
       OR r.currency IS DISTINCT FROM NEW.currency
       OR p."providerAccountId" <> NEW."providerAccountId"
       OR NEW."providerModelId" = ''
       OR (p."scopeType" = 'POOL_PROVIDER_MODEL'
         AND (p."poolId" IS DISTINCT FROM NEW."poolId"
           OR p."providerModelId" IS DISTINCT FROM NEW."providerModelId")) THEN
      RAISE EXCEPTION 'budget reservation must match its policy version and rule' USING ERRCODE = '23514';
    END IF;
    IF NEW."credentialId" IS NOT NULL THEN
      SELECT * INTO c FROM provider_credential WHERE id = NEW."credentialId";
      IF c."userId" IS DISTINCT FROM NEW."userId" OR c."providerAccountId" IS DISTINCT FROM p."providerAccountId" THEN
        RAISE EXCEPTION 'budget reservation credential must match policy account' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_model m WHERE m.id = NEW."providerModelId"
      AND m."userId" = NEW."userId" AND m."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'budget reservation model must match provider account' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_attempt a
      WHERE a."attemptId" = NEW."attemptId" AND a."fencingToken" = NEW."fencingToken"
        AND (a."userId", a."providerAccountId", a."providerModelId", a."credentialId",
             a."poolId", a."requestId", a."accountingVersion", a."pricingVersion",
             a."liabilityTokens", a."liabilitySpend", a."liabilityCurrency")
          IS NOT DISTINCT FROM
            (NEW."userId", NEW."providerAccountId", NEW."providerModelId", NEW."credentialId",
             NEW."poolId", NEW."requestId", NEW."accountingVersion", NEW."pricingVersion",
             NEW."liabilityTokens", NEW."liabilitySpend", NEW."liabilityCurrency")) THEN
      RAISE EXCEPTION 'budget reservation must match its provider attempt anchor' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM provider_budget_reservation existing
      WHERE existing."attemptId" = NEW."attemptId" AND existing.id <> NEW.id
        AND (existing."userId", existing."providerAccountId", existing."providerModelId",
             existing."credentialId", existing."poolId", existing."requestId",
             existing."fencingToken", existing."accountingVersion", existing."pricingVersion",
             existing."liabilityTokens", existing."liabilitySpend", existing."liabilityCurrency")
          IS DISTINCT FROM
            (NEW."userId", NEW."providerAccountId", NEW."providerModelId",
             NEW."credentialId", NEW."poolId", NEW."requestId",
             NEW."fencingToken", NEW."accountingVersion", NEW."pricingVersion",
             NEW."liabilityTokens", NEW."liabilitySpend", NEW."liabilityCurrency")) THEN
      RAISE EXCEPTION 'budget attempt identity is immutable globally' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_pricing_version' THEN
    IF NOT EXISTS (SELECT 1 FROM provider_model m WHERE m.id = NEW."providerModelId"
      AND m."userId" = NEW."userId" AND m."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'pricing model must match provider account' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_usage_ledger' THEN
    IF NOT EXISTS (SELECT 1 FROM provider_attempt a
      WHERE a."attemptId" = NEW."attemptId" AND a."fencingToken" = NEW."fencingToken"
        AND (a."userId", a."providerAccountId", a."providerModelId", a."credentialId",
             a."poolId", a."requestId", a."accountingVersion", a."pricingVersion")
          IS NOT DISTINCT FROM
            (NEW."userId", NEW."providerAccountId", NEW."providerModelId", NEW."credentialId",
             NEW."poolId", NEW."requestId", NEW."accountingVersion", NEW."pricingVersion")) THEN
      RAISE EXCEPTION 'usage ledger must match its provider attempt anchor' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_model m WHERE m.id = NEW."providerModelId"
      AND m."userId" = NEW."userId" AND m."providerAccountId" = NEW."providerAccountId")
      OR (NEW."pricingVersion" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_pricing_version pv
        WHERE pv."providerModelId" = NEW."providerModelId"
          AND pv.version = NEW."pricingVersion" AND pv.currency = NEW.currency
          AND pv."providerAccountId" = NEW."providerAccountId" AND pv."userId" = NEW."userId")) THEN
      RAISE EXCEPTION 'usage ledger provider and pricing graph is inconsistent' USING ERRCODE = '23514';
    END IF;
    IF NEW."credentialId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_credential credential
      WHERE credential.id = NEW."credentialId" AND credential."userId" = NEW."userId"
        AND credential."providerAccountId" = NEW."providerAccountId") THEN
      RAISE EXCEPTION 'usage ledger credential is inconsistent' USING ERRCODE = '23514';
    END IF;
    IF NEW."reservationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM provider_budget_reservation br
      WHERE br.id = NEW."reservationId"
        AND br."userId" = NEW."userId" AND br."providerAccountId" = NEW."providerAccountId"
        AND br."requestId" = NEW."requestId" AND br."attemptId" = NEW."attemptId"
        AND br."fencingToken" = NEW."fencingToken"
        AND br."providerModelId" = NEW."providerModelId"
        AND br."credentialId" IS NOT DISTINCT FROM NEW."credentialId"
        AND br."poolId" IS NOT DISTINCT FROM NEW."poolId"
        AND br."accountingVersion" = NEW."accountingVersion"
        AND br."pricingVersion" IS NOT DISTINCT FROM NEW."pricingVersion") THEN
      RAISE EXCEPTION 'usage ledger reservation is inconsistent' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_budget_settlement' THEN
    IF NOT EXISTS (SELECT 1 FROM provider_budget_reservation br WHERE br.id = NEW."reservationId"
      AND br."userId" = NEW."userId" AND br."attemptId" = NEW."attemptId"
      AND br."fencingToken" = NEW."fencingToken" AND br.currency IS NOT DISTINCT FROM NEW.currency) THEN
      RAISE EXCEPTION 'budget settlement must match its reservation identity' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM provider_attempt a
      WHERE a."attemptId" = NEW."attemptId" AND a."fencingToken" = NEW."fencingToken"
        AND (a."userId", a."providerAccountId", a."providerModelId", a."credentialId",
             a."poolId", a."requestId", a."accountingVersion", a."pricingVersion")
          IS NOT DISTINCT FROM
            (NEW."userId", NEW."providerAccountId", NEW."providerModelId", NEW."credentialId",
             NEW."poolId", NEW."requestId", NEW."accountingVersion", NEW."pricingVersion")) THEN
      RAISE EXCEPTION 'budget settlement must match its provider attempt anchor' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'provider_audit_event' AND NEW."providerAccountId" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM provider_account a WHERE a.id = NEW."providerAccountId" AND a."userId" = NEW."userId") THEN
      RAISE EXCEPTION 'provider audit account must belong to actor owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$provider_budget_graph$;

DROP TRIGGER IF EXISTS provider_budget_policy_graph_consistency ON provider_budget_policy;
CREATE TRIGGER provider_budget_policy_graph_consistency BEFORE INSERT OR UPDATE ON provider_budget_policy
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
-- DL-1 (d): provider_attempt, provider_budget_reservation, provider_usage_ledger
-- and provider_budget_settlement are hot-path history without foreign keys to
-- the graph. Their identity is immutable after insert (the *_transition and
-- *_immutable triggers), so the graph is checked once, at INSERT: a later
-- state transition (terminalization, settlement) must still commit when a
-- referenced pool or budget policy was deleted meanwhile.
DROP TRIGGER IF EXISTS provider_budget_reservation_graph_consistency ON provider_budget_reservation;
CREATE TRIGGER provider_budget_reservation_graph_consistency BEFORE INSERT ON provider_budget_reservation
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
DROP TRIGGER IF EXISTS provider_attempt_graph_consistency ON provider_attempt;
CREATE TRIGGER provider_attempt_graph_consistency BEFORE INSERT ON provider_attempt
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
DROP TRIGGER IF EXISTS provider_pricing_version_graph_consistency ON provider_pricing_version;
CREATE TRIGGER provider_pricing_version_graph_consistency BEFORE INSERT OR UPDATE ON provider_pricing_version
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
DROP TRIGGER IF EXISTS provider_usage_ledger_graph_consistency ON provider_usage_ledger;
CREATE TRIGGER provider_usage_ledger_graph_consistency BEFORE INSERT ON provider_usage_ledger
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
DROP TRIGGER IF EXISTS provider_budget_settlement_graph_consistency ON provider_budget_settlement;
CREATE TRIGGER provider_budget_settlement_graph_consistency BEFORE INSERT ON provider_budget_settlement
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();
DROP TRIGGER IF EXISTS provider_audit_event_graph_consistency ON provider_audit_event;
CREATE TRIGGER provider_audit_event_graph_consistency BEFORE INSERT OR UPDATE ON provider_audit_event
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_graph_consistency();

CREATE OR REPLACE FUNCTION enforce_provider_budget_history_transitions()
RETURNS trigger LANGUAGE plpgsql AS $provider_budget_history$
BEGIN
  IF TG_TABLE_NAME = 'provider_budget_rule' THEN
    RAISE EXCEPTION 'provider budget rules are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.active THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."scopeType" IS DISTINCT FROM OLD."scopeType"
       OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
       OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
       OR NEW."providerModelId" IS DISTINCT FROM OLD."providerModelId"
       OR NEW.version IS DISTINCT FROM OLD.version OR NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt"
       OR NEW.active OR NEW."deactivatedAt" IS NULL THEN
      RAISE EXCEPTION 'activated provider budget policy is immutable except deactivation' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT OLD.active AND OLD."activatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'deactivated provider budget policy cannot be reactivated' USING ERRCODE = '55000';
  END IF;
  IF NOT OLD.active AND OLD."activatedAt" IS NULL THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."scopeType" IS DISTINCT FROM OLD."scopeType"
       OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
       OR NEW."poolId" IS DISTINCT FROM OLD."poolId"
       OR NEW."providerModelId" IS DISTINCT FROM OLD."providerModelId"
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NOT NEW.active OR NEW."activatedAt" IS NULL OR NEW."deactivatedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'provider budget policy permits only controlled activation' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$provider_budget_history$;

DROP TRIGGER IF EXISTS provider_budget_rule_immutable ON provider_budget_rule;
CREATE TRIGGER provider_budget_rule_immutable BEFORE UPDATE OR DELETE ON provider_budget_rule
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_history_transitions();
DROP TRIGGER IF EXISTS provider_budget_policy_transition ON provider_budget_policy;
CREATE TRIGGER provider_budget_policy_transition BEFORE UPDATE ON provider_budget_policy
FOR EACH ROW EXECUTE FUNCTION enforce_provider_budget_history_transitions();

-- DL-1 design (d) (#78): usage rollups have no foreign key to "user" (they
-- are hot-path history), so a user DELETE no longer writes them. The former
-- AFTER DELETE trigger that merged a deleted requester's rows into the ''
-- sentinel requester made the user delete write hot-path rows (F2-02: it
-- could deadlock with a finalizer or compaction). The same merge now runs in
-- bounded SKIP LOCKED batches: before the delete in the user-deletion drain,
-- and after it in the history purge sweeper for rows written by requests
-- still in flight (packages/db/src/usage-rollup-requester-drain.ts).
DROP TRIGGER IF EXISTS usage_rollup_detach_requester ON "user";
DROP FUNCTION IF EXISTS detach_usage_rollup_requester();

-- DEL-STATE commit-point denial: no browser session commits for a user whose
-- deletion is pending ("deletionRequestedAt" set). The application's Better
-- Auth hook (session.create.before) refuses the ordinary case with a 403, but
-- its read and the adapter's INSERT are separate statements, so a deletion
-- mark committed between them would otherwise leave a live session behind.
--
-- The owner row is read FOR SHARE, which conflicts with the mark's UPDATE
-- (FOR NO KEY UPDATE) but not with the FOR KEY SHARE of ordinary child
-- inserts. So the two serialize in either order (READ COMMITTED re-reads the
-- newest row version after a wait):
--  * mark first: this insert waits for the mark to commit, then sees the
--    marker and is refused;
--  * insert first: the mark (requestUserDeletion: UPDATE "user", then DELETE
--    FROM session, one transaction) waits for this transaction, and its
--    DELETE then removes the committed session.
-- FOR KEY SHARE would not serialize with the mark and leaks the session.
--
-- Lock order: the inserter holds nothing else a capacity transaction can wait
-- on (a Better Auth session insert is a single statement, or runs in
-- sign-up's transaction on a brand-new user row), and it takes no capacity
-- lock after this one, so waiting here on a mark, an L7 user lock or any user
-- writer closes no cycle. Nothing in the deletion subsystem inserts sessions.
--
-- Impersonation (IMP-MARK): Better Auth's impersonate-user inserts a session
-- with "userId" = the target and "impersonatedBy" = the acting admin, a plain
-- column without a foreign key. The mark deletes the sessions a user acts
-- through (userId OR impersonatedBy), so the insert also reads the
-- impersonator FOR SHARE, with the same two orders as above, and refuses a
-- pending or missing (deleted) impersonator. Both reads are FOR SHARE on
-- "user" rows and only wait on user writers; two FOR SHARE locks never
-- conflict with each other, and the mark and the ordered delete each write one
-- user row, so the pair closes no cycle either.
CREATE OR REPLACE FUNCTION refuse_session_for_deleting_user()
RETURNS trigger LANGUAGE plpgsql AS $session_refuse_deleting_user$
DECLARE
  pending boolean;
BEGIN
  SELECT u."deletionRequestedAt" IS NOT NULL INTO pending
    FROM "user" u
   WHERE u.id = NEW."userId"
     FOR SHARE;
  IF FOUND AND pending THEN
    RAISE EXCEPTION 'user deletion pending' USING ERRCODE = 'WMPD1';
  END IF;
  IF NEW."impersonatedBy" IS NOT NULL THEN
    SELECT u."deletionRequestedAt" IS NOT NULL INTO pending
      FROM "user" u
     WHERE u.id = NEW."impersonatedBy"
       FOR SHARE;
    IF NOT FOUND OR pending THEN
      RAISE EXCEPTION 'user deletion pending' USING ERRCODE = 'WMPD1';
    END IF;
  END IF;
  RETURN NEW;
END;
$session_refuse_deleting_user$;

DROP TRIGGER IF EXISTS session_refuse_deleting_user ON session;
CREATE TRIGGER session_refuse_deleting_user BEFORE INSERT ON session
FOR EACH ROW EXECUTE FUNCTION refuse_session_for_deleting_user();

-- DEL-STATE single writer of the deletion marker: only the user-deletion
-- subsystem (packages/db/src/parent-deletion.ts abandonUserDeletion) clears
-- "deletionRequestedAt" or rewrites the generation of a pending deletion.
-- It does so inside a transaction that first sets the transaction-local
-- setting wsmp.user_deletion_writer = 'on'; any other writer (a Better Auth
-- admin route writing arbitrary user fields, a future dashboard write, an
-- ad-hoc UPDATE) is refused with SQLSTATE WMPD2, so a pending deletion can
-- never be silently withdrawn while its worker still runs. Setting the
-- marker (requestUserDeletion, which also gives a marker left without a
-- generation its first one) and moving its timestamp are not guarded: they
-- never withdraw a deletion. A row DELETE is not an UPDATE.
-- The check reads only NEW/OLD of the row being updated: no lock, so it adds
-- nothing to any lock order.
CREATE OR REPLACE FUNCTION refuse_user_deletion_marker_clear()
RETURNS trigger LANGUAGE plpgsql AS $user_deletion_marker_guard$
BEGIN
  IF OLD."deletionRequestedAt" IS NOT NULL
     AND (NEW."deletionRequestedAt" IS NULL
          OR (OLD."deletionGeneration" IS NOT NULL
              AND NEW."deletionGeneration" IS DISTINCT FROM OLD."deletionGeneration"))
     AND current_setting('wsmp.user_deletion_writer', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'only the user deletion subsystem clears a pending deletion'
      USING ERRCODE = 'WMPD2';
  END IF;
  RETURN NEW;
END;
$user_deletion_marker_guard$;

DROP TRIGGER IF EXISTS user_deletion_marker_guard ON "user";
CREATE TRIGGER user_deletion_marker_guard
BEFORE UPDATE OF "deletionRequestedAt", "deletionGeneration" ON "user"
FOR EACH ROW EXECUTE FUNCTION refuse_user_deletion_marker_clear();

-- PR3: preferences are grantee-only configuration. The composite FKs bind
-- the exact grant and requester-owned model; no nullable composite SET NULL.
CREATE OR REPLACE FUNCTION enforce_pool_fallback_preference_grantee() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pool_grant g JOIN model_pool p ON p.id = g."poolId"
     WHERE g.id = NEW."poolGrantId" AND g."poolId" = NEW."poolId"
       AND g."granteeUserId" = NEW."userId" AND p."userId" <> NEW."userId"
       AND g."ownerUserId" = p."userId"
  ) THEN
    RAISE EXCEPTION 'own-key preference requires the exact non-owner grant' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pool_fallback_preference_grantee ON pool_fallback_preference;
CREATE TRIGGER pool_fallback_preference_grantee BEFORE INSERT OR UPDATE ON pool_fallback_preference
FOR EACH ROW EXECUTE FUNCTION enforce_pool_fallback_preference_grantee();

-- DL-1 design (d) (#78): fences. Every advisory lock the application takes is
-- a transaction-scoped "fence" named LL:kind:id (LL = a two-digit level that
-- fixes the global order; see packages/db/src/capacity-lock-order.ts, the
-- only caller). A fence is taken before the transaction's first row lock or
-- write: once it has an xid (a row lock or a write) the request is refused
-- with WMPF1. (nextval takes no lock; it assigns an xid only when it WAL-logs
-- a new batch of values, so it may or may not trip the check.) Fences are taken in ascending name order across the
-- whole transaction (WMPF2). The held set is recorded in the
-- transaction-local setting wsmp.fences (",name,name,") for the graph-write
-- triggers below. With wait = false (sweepers) a busy fence returns false at
-- once; the caller then ends its transaction without waiting.
CREATE OR REPLACE FUNCTION wsmp_acquire_fences(requested TEXT[], wait BOOLEAN)
RETURNS BOOLEAN LANGUAGE plpgsql AS $wsmp_acquire_fences$
DECLARE
  held TEXT := COALESCE(NULLIF(current_setting('wsmp.fences', true), ''), ',');
  last_fence TEXT := COALESCE(current_setting('wsmp.fence_last', true), '');
  fence TEXT;
BEGIN
  IF txid_current_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'fences must be taken before the transaction locks or writes a row'
      USING ERRCODE = 'WMPF1';
  END IF;
  FOREACH fence IN ARRAY requested LOOP
    IF fence IS NULL OR fence !~ '^[0-9]{2}:[a-z][a-z-]*:[^,]+$' THEN
      RAISE EXCEPTION 'malformed fence %', fence USING ERRCODE = 'WMPF3';
    END IF;
    CONTINUE WHEN strpos(held, ',' || fence || ',') > 0;
    IF last_fence <> '' AND fence COLLATE "C" <= last_fence COLLATE "C" THEN
      RAISE EXCEPTION 'fence % requested after fence %', fence, last_fence
        USING ERRCODE = 'WMPF2';
    END IF;
    IF wait THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(substr(fence, 4), 0));
    ELSIF NOT pg_try_advisory_xact_lock(hashtextextended(substr(fence, 4), 0)) THEN
      PERFORM set_config('wsmp.fences', held, true);
      PERFORM set_config('wsmp.fence_last', last_fence, true);
      RETURN false;
    END IF;
    held := held || fence || ',';
    last_fence := fence;
  END LOOP;
  PERFORM set_config('wsmp.fences', held, true);
  PERFORM set_config('wsmp.fence_last', last_fence, true);
  RETURN true;
END;
$wsmp_acquire_fences$;

CREATE OR REPLACE FUNCTION wsmp_require_fence(fence TEXT, relation TEXT)
RETURNS VOID LANGUAGE plpgsql AS $wsmp_require_fence$
DECLARE
  held TEXT := COALESCE(current_setting('wsmp.fences', true), '');
BEGIN
  IF strpos(held, ',' || fence || ',') = 0 AND strpos(held, ',*,') = 0 THEN
    RAISE EXCEPTION 'write to % requires fence %', relation, fence
      USING ERRCODE = 'WMPF4',
            HINT = 'Take it with acquireFences (packages/db/src/capacity-lock-order.ts) before the first row lock or write of the transaction.';
  END IF;
END;
$wsmp_require_fence$;

-- Rows this transaction INSERTED, recorded by an AFTER INSERT trigger (so an
-- upsert that only updates an existing row never records it) in the
-- transaction-local setting wsmp.created as ",<table>:<id>,". No other
-- transaction can see such a row, so writing its policy needs no policy
-- fence. An earlier UPDATE of an existing row does NOT count (the row's xmin
-- would equal this transaction after any write, including one that needs no
-- fence, so xmin cannot tell the two apart). A rolled-back savepoint reverts
-- the setting with it.
CREATE OR REPLACE FUNCTION wsmp_row_created_here(relation TEXT, row_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $wsmp_created_here$
  SELECT strpos(COALESCE(current_setting('wsmp.created', true), ''),
                ',' || relation || ':' || row_id || ',') > 0
$wsmp_created_here$;

CREATE OR REPLACE FUNCTION wsmp_record_created_row()
RETURNS trigger LANGUAGE plpgsql AS $wsmp_record_created$
BEGIN
  PERFORM set_config('wsmp.created',
    COALESCE(current_setting('wsmp.created', true), '') || ',' || TG_TABLE_NAME || ':' || NEW.id || ',',
    true);
  RETURN NULL;
END;
$wsmp_record_created$;

-- The users whose owner fence a write of this graph row needs: the row's
-- owner, both parties of a pool grant, and for an allowlist entry both the
-- token owner and the referenced resource's owner (an entry links two
-- owners' graphs, so a delete of either side reaches it). A parent that no
-- longer exists contributes nothing: the write is then part of that parent's
-- cascade, whose own trigger checked its owner, or its foreign key fails.
CREATE OR REPLACE FUNCTION wsmp_graph_row_owners(relation TEXT, row_data JSONB)
RETURNS TEXT[] LANGUAGE plpgsql STABLE AS $wsmp_graph_row_owners$
BEGIN
  RETURN CASE relation
    WHEN 'user' THEN ARRAY[row_data ->> 'id']
    WHEN 'pool_member' THEN ARRAY[
      (SELECT "userId" FROM model_pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_grant' THEN ARRAY[row_data ->> 'ownerUserId', row_data ->> 'granteeUserId']
    WHEN 'model_api_token_allowlist_entry' THEN ARRAY[
      (SELECT "userId" FROM model_api_token WHERE id = row_data ->> 'modelApiTokenId'),
      (SELECT "userId" FROM model_pool WHERE id = row_data ->> 'modelPoolId'),
      (SELECT "userId" FROM discovered_model WHERE id = row_data ->> 'discoveredModelId'),
      (SELECT "userId" FROM execution_target WHERE id = row_data ->> 'executionTargetId')]
    WHEN 'provider_budget_rule' THEN ARRAY[
      (SELECT "userId" FROM provider_budget_policy WHERE id = row_data ->> 'policyId')]
    ELSE ARRAY[row_data ->> 'userId']
  END;
END;
$wsmp_graph_row_owners$;

-- Graph-write fence (writer class M). An INSERT, a DELETE (a cascaded one
-- too) or an UPDATE that changes an identity/reference column (TG_ARGV[0]) or
-- a capacity-policy column (TG_ARGV[1]) of a graph row needs the owner fence
-- of every owner of the row; a policy change also needs the fences of the
-- admission views it changes (capacity-policy:<target>, capacity:<capacity>),
-- unless this transaction created the row. Status columns (health, last-used,
-- connection state, display fields) are not listed: hot-path writers change
-- them without a fence, one row per statement. A missing fence raises WMPF4:
-- a forgotten fence fails deterministically instead of deadlocking.
-- Plain SELECTs only: the check adds no lock.
CREATE OR REPLACE FUNCTION enforce_graph_write_fence()
RETURNS trigger LANGUAGE plpgsql AS $graph_write_fence$
DECLARE
  structural TEXT[] := string_to_array(TG_ARGV[0], ',');
  policy TEXT[] := string_to_array(COALESCE(TG_ARGV[1], ''), ',');
  row_new JSONB;
  row_old JSONB;
  column_name TEXT;
  changed BOOLEAN := TG_OP <> 'UPDATE';
  policy_changed BOOLEAN := false;
  owners TEXT[] := ARRAY[]::TEXT[];
  owner_id TEXT;
  target_id TEXT;
BEGIN
  IF strpos(COALESCE(current_setting('wsmp.fences', true), ''), ',*,') > 0 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    row_new := to_jsonb(NEW);
    owners := owners || wsmp_graph_row_owners(TG_TABLE_NAME, row_new);
  END IF;
  IF TG_OP <> 'INSERT' THEN
    row_old := to_jsonb(OLD);
    owners := owners || wsmp_graph_row_owners(TG_TABLE_NAME, row_old);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    FOREACH column_name IN ARRAY structural LOOP
      IF (row_new -> column_name) IS DISTINCT FROM (row_old -> column_name) THEN
        changed := true;
      END IF;
    END LOOP;
    FOREACH column_name IN ARRAY policy LOOP
      IF (row_new -> column_name) IS DISTINCT FROM (row_old -> column_name) THEN
        policy_changed := true;
      END IF;
    END LOOP;
    IF NOT changed AND NOT policy_changed THEN
      RETURN NEW;
    END IF;
  END IF;
  FOREACH owner_id IN ARRAY owners LOOP
    CONTINUE WHEN owner_id IS NULL;
    PERFORM wsmp_require_fence('00:owner:' || owner_id, TG_TABLE_NAME);
  END LOOP;

  IF TG_TABLE_NAME = 'pool_member' THEN
    -- Membership and member policy feed the admission view of the member's
    -- target (and the reservations of its capacity).
    IF TG_OP = 'INSERT' THEN
      target_id := NEW."executionTargetId";
      IF target_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 WHERE wsmp_row_created_here('execution_target', target_id)
      ) THEN
        PERFORM wsmp_require_fence('06:capacity-policy:' || target_id, TG_TABLE_NAME);
      END IF;
    ELSIF TG_OP = 'UPDATE' AND policy_changed
          AND NOT wsmp_row_created_here(TG_TABLE_NAME, OLD.id) THEN
      IF OLD."executionTargetId" IS NOT NULL THEN
        PERFORM wsmp_require_fence('06:capacity-policy:' || OLD."executionTargetId", TG_TABLE_NAME);
      END IF;
      IF NEW."executionTargetId" IS NOT NULL THEN
        PERFORM wsmp_require_fence('06:capacity-policy:' || NEW."executionTargetId", TG_TABLE_NAME);
      END IF;
    END IF;
  ELSIF policy_changed AND NOT wsmp_row_created_here(TG_TABLE_NAME, OLD.id) THEN
    IF TG_TABLE_NAME = 'execution_target' THEN
      PERFORM wsmp_require_fence('06:capacity-policy:' || NEW.id, TG_TABLE_NAME);
    ELSIF TG_TABLE_NAME = 'inference_capacity' THEN
      PERFORM wsmp_require_fence('08:capacity:' || NEW.id, TG_TABLE_NAME);
    ELSIF TG_TABLE_NAME = 'model_pool' THEN
      FOR target_id IN
        SELECT DISTINCT member."executionTargetId" FROM pool_member member
         WHERE member."poolId" = NEW.id AND member."executionTargetId" IS NOT NULL
      LOOP
        PERFORM wsmp_require_fence('06:capacity-policy:' || target_id, TG_TABLE_NAME);
      END LOOP;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$graph_write_fence$;

DO $install_graph_write_fences$
DECLARE
  spec RECORD;
BEGIN
  FOR spec IN SELECT * FROM (VALUES
    ('user', '', ''),
    ('cli_device', 'id,userId,slug', ''),
    ('endpoint', 'id,userId,cliDeviceId,slug', ''),
    ('discovered_model', 'id,userId,endpointId,upstreamModelId,encodedModelId,slug', ''),
    ('execution_target', 'id,userId,kind,discoveredModelId,providerModelId',
      'inferenceCapacityId,directPriority,directConcurrencyLimit,directReservedSlots,directBorrowPolicy,directWaitBudgetMs,directContextCeiling,directContextMargin'),
    ('inference_capacity', 'id,userId,runtimeIdentityKey', 'hardConcurrencyLimit'),
    ('model_pool', 'id,userId,slug,transformerDiscoveredModelId',
      'capacityPriority,capacityConcurrencyLimit,capacityReservedSlots,capacityBorrowPolicy,capacityWaitBudgetMs,capacityContextCeiling,capacityContextMargin'),
    ('pool_member', 'id,poolId,discoveredModelId,executionTargetId',
      'tier,capacityPriority,capacityConcurrencyMode,capacityConcurrencyLimit,capacityReservedSlots,capacityBorrowPolicy,capacityWaitBudgetMode,capacityWaitBudgetMs,capacityContextCeilingMode,capacityContextCeiling,capacityContextMargin'),
    ('pool_grant', 'id,poolId,ownerUserId,granteeUserId', ''),
    ('model_api_token', 'id,userId,lookupPrefix,secretDigest', ''),
    ('model_api_token_allowlist_entry', 'id,modelApiTokenId,target,discoveredModelId,executionTargetId,modelPoolId', ''),
    ('provider_account', 'id,userId,currentCredentialId', ''),
    ('provider_model', 'id,userId,providerAccountId,upstreamModelId', ''),
    ('provider_credential', 'id,userId,providerAccountId,replacedById', ''),
    ('provider_budget_policy', 'id,userId,scopeType,providerAccountId,poolId,providerModelId', ''),
    ('provider_budget_rule', 'id,policyId', ''),
    ('provider_pricing_version', 'id,userId,providerAccountId,providerModelId', ''),
    ('pool_fallback_preference', 'id,userId,poolId,poolGrantId,providerModelId', '')
  ) AS t(relation, structural, policy)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS z_graph_write_fence ON %I', spec.relation);
    EXECUTE format('DROP TRIGGER IF EXISTS z_graph_update_fence ON %I', spec.relation);
    IF spec.relation = 'user' THEN
      -- The user row: only its delete (the root of the user cascade) is fenced.
      EXECUTE format(
        'CREATE TRIGGER z_graph_write_fence BEFORE DELETE ON "user" '
        'FOR EACH ROW EXECUTE FUNCTION enforce_graph_write_fence(%L, %L)', '', '');
    ELSE
      IF spec.policy <> '' THEN
        EXECUTE format('DROP TRIGGER IF EXISTS z_graph_created_row ON %I', spec.relation);
        EXECUTE format(
          'CREATE TRIGGER z_graph_created_row AFTER INSERT ON %I '
          'FOR EACH ROW EXECUTE FUNCTION wsmp_record_created_row()', spec.relation);
      END IF;
      EXECUTE format(
        'CREATE TRIGGER z_graph_write_fence BEFORE INSERT OR DELETE ON %I '
        'FOR EACH ROW EXECUTE FUNCTION enforce_graph_write_fence(%L, %L)',
        spec.relation, spec.structural, spec.policy);
      EXECUTE format(
        'CREATE TRIGGER z_graph_update_fence BEFORE UPDATE OF %s ON %I '
        'FOR EACH ROW EXECUTE FUNCTION enforce_graph_write_fence(%L, %L)',
        (SELECT string_agg(format('%I', column_name), ', ')
           FROM unnest(string_to_array(
             spec.structural || CASE WHEN spec.policy = '' THEN '' ELSE ',' || spec.policy END,
             ',')) AS column_name),
        spec.relation, spec.structural, spec.policy);
    END IF;
  END LOOP;
END;
$install_graph_write_fences$;

DROP FUNCTION IF EXISTS wsmp_written_by_this_transaction(XID);

COMMIT;
