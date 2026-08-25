-- Database invariants and compatibility backfills that Prisma cannot express.
-- This file is idempotent and is applied by the repository db:push wrappers.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS admission_enqueue_sequence AS bigint MINVALUE 0 START 1;

-- Serialize the compatibility cutover with old writers. PostgreSQL trigger DDL
-- also takes strong table locks, but taking every participating table up front
-- in parent-to-child order avoids observing a half-reconciled graph and gives
-- concurrent transactions one consistent lock order. An insert that committed
-- before these locks is included by the backfill below; one that starts after
-- the locks is released sees the installed trigger.
LOCK TABLE discovered_model, execution_target, model_pool, model_api_token,
  pool_member, model_api_token_allowlist_entry, response_stickiness_record,
  relay_request, inference_capacity, admission_request, capacity_waiter,
  capacity_lease IN SHARE ROW EXCLUSIVE MODE;

-- Capacity policy bounds are database invariants because admission correctness
-- must not depend on every rolling-deploy writer running the same validator.
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
         WHEN member."capacityConcurrencyLimit" IS NULL THEN 'POOL' ELSE 'MEMBER' END,
       "effectiveConcurrencyScopeId" = CASE
         WHEN member."capacityConcurrencyLimit" IS NULL THEN waiter."poolId" ELSE waiter."poolMemberId" END
  FROM pool_member member
 WHERE waiter."effectiveConcurrencyScope" = ''
   AND member.id = waiter."poolMemberId";

ALTER TABLE inference_capacity DROP CONSTRAINT IF EXISTS inference_capacity_limits_check;
ALTER TABLE inference_capacity ADD CONSTRAINT inference_capacity_limits_check CHECK (
  ("hardConcurrencyLimit" IS NULL OR "hardConcurrencyLimit" > 0)
  AND ("physicalMaxContext" IS NULL OR "physicalMaxContext" > 0)
  AND "schedulerCursor" BETWEEN 0 AND 31
  AND "schedulerVersion" > 0
  AND "nextFencingToken" > 0
  AND ((jsonb_typeof("schedulerDeficits") = 'array' AND jsonb_array_length("schedulerDeficits") = 32)
    OR "schedulerDeficits" = '{}'::jsonb)
);

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

ALTER TABLE pool_member DROP CONSTRAINT IF EXISTS pool_member_capacity_policy_check;
ALTER TABLE pool_member ADD CONSTRAINT pool_member_capacity_policy_check CHECK (
  ("capacityPriority" IS NULL OR "capacityPriority" BETWEEN 0 AND 31)
  AND ("capacityConcurrencyLimit" IS NULL OR "capacityConcurrencyLimit" > 0)
  AND ("capacityReservedSlots" IS NULL OR "capacityReservedSlots" >= 0)
  AND ("capacityWaitBudgetMs" IS NULL OR "capacityWaitBudgetMs" >= 0)
  AND ("capacityContextCeiling" IS NULL OR "capacityContextCeiling" > 0)
  AND "capacityContextMargin" >= 0
  AND ("capacityContextCeiling" IS NULL OR "capacityContextMargin" < "capacityContextCeiling")
);

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

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_admission_telemetry_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_admission_telemetry_check CHECK (
  ("admissionWaitDurationMs" IS NULL OR "admissionWaitDurationMs" >= 0)
  AND ("admissionReservationClass" IS NULL OR "admissionReservationClass" BETWEEN 0 AND 31)
  AND ("admissionFencingToken" IS NULL OR "admissionFencingToken" > 0)
);

-- Partial indexes document and enforce the live-winner invariant even if a
-- future archival change relaxes the stronger one-lease-per-attempt FK.
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_one_admitted_winner
  ON capacity_waiter ("admissionRequestId") WHERE state = 'ADMITTED';
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_unique_direct_candidate
  ON capacity_waiter ("admissionRequestId", "capacityId", "executionTargetId")
  WHERE "poolMemberId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capacity_lease_one_live_attempt
  ON capacity_lease ("admissionRequestId") WHERE state = 'ACTIVE';

CREATE OR REPLACE FUNCTION enforce_capacity_reference_consistency()
RETURNS trigger LANGUAGE plpgsql AS $capacity_reference_check$
DECLARE
  request_owner TEXT;
  request_pool TEXT;
  request_direct_target TEXT;
  target_owner TEXT;
  target_capacity TEXT;
  member_pool TEXT;
  member_target TEXT;
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
    IF NEW."poolId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM model_pool pool
       WHERE pool.id = NEW."poolId" AND pool."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'admission request pool must have the same owner'
        USING ERRCODE = '23514';
    END IF;
    IF NEW."directExecutionTargetId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM execution_target target
       WHERE target.id = NEW."directExecutionTargetId" AND target."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'direct admission target must have the same owner'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT "userId", "poolId", "directExecutionTargetId"
    INTO request_owner, request_pool, request_direct_target
    FROM admission_request WHERE id = NEW."admissionRequestId";
  SELECT "userId", "inferenceCapacityId" INTO target_owner, target_capacity
    FROM execution_target WHERE id = NEW."executionTargetId";
  IF request_owner IS NULL OR request_owner <> NEW."userId"
     OR target_owner <> NEW."userId" OR target_capacity IS DISTINCT FROM NEW."capacityId" THEN
    RAISE EXCEPTION 'capacity admission references must share owner and physical capacity'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'capacity_waiter' AND TG_OP = 'UPDATE'
     AND (NEW."effectivePriority" IS DISTINCT FROM OLD."effectivePriority"
       OR NEW."effectiveConcurrencyLimit" IS DISTINCT FROM OLD."effectiveConcurrencyLimit"
       OR NEW."effectiveConcurrencyScope" IS DISTINCT FROM OLD."effectiveConcurrencyScope"
       OR NEW."effectiveConcurrencyScopeId" IS DISTINCT FROM OLD."effectiveConcurrencyScopeId"
       OR NEW."effectiveReservedSlots" IS DISTINCT FROM OLD."effectiveReservedSlots"
       OR NEW."effectiveBorrowPolicy" IS DISTINCT FROM OLD."effectiveBorrowPolicy") THEN
    RAISE EXCEPTION 'capacity waiter policy snapshot is immutable'
      USING ERRCODE = '23514';
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
    SELECT "poolId", "executionTargetId" INTO member_pool, member_target
      FROM pool_member WHERE id = NEW."poolMemberId";
    IF member_pool IS DISTINCT FROM NEW."poolId"
       OR member_target IS DISTINCT FROM NEW."executionTargetId"
       OR request_pool IS DISTINCT FROM NEW."poolId" THEN
      RAISE EXCEPTION 'capacity admission pool candidate is inconsistent'
        USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'capacity_waiter' AND NOT EXISTS (
      SELECT 1
        FROM pool_member member
        JOIN model_pool pool ON pool.id = member."poolId"
       WHERE member.id = NEW."poolMemberId"
         AND NEW."effectivePriority" = COALESCE(member."capacityPriority", pool."capacityPriority")
         AND NEW."effectiveConcurrencyLimit" IS NOT DISTINCT FROM
           COALESCE(member."capacityConcurrencyLimit", pool."capacityConcurrencyLimit")
         AND NEW."effectiveConcurrencyScope" = CASE
           WHEN member."capacityConcurrencyLimit" IS NULL THEN 'POOL' ELSE 'MEMBER' END
         AND NEW."effectiveConcurrencyScopeId" = CASE
           WHEN member."capacityConcurrencyLimit" IS NULL THEN pool.id ELSE member.id END
         AND NEW."effectiveReservedSlots" = COALESCE(member."capacityReservedSlots", pool."capacityReservedSlots")
         AND NEW."effectiveBorrowPolicy" = COALESCE(member."capacityBorrowPolicy", pool."capacityBorrowPolicy")
    ) THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot must match its pool member policy'
        USING ERRCODE = '23514';
    END IF;
  ELSIF request_pool IS NOT NULL THEN
    RAISE EXCEPTION 'pool admission requires a pool member candidate'
      USING ERRCODE = '23514';
  ELSIF request_direct_target IS DISTINCT FROM NEW."executionTargetId" THEN
    RAISE EXCEPTION 'direct admission candidate must match its source target'
      USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'capacity_waiter' AND NOT EXISTS (
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
  RETURN NEW;
END
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
     'ANTHROPIC_MESSAGES',
     'OPENAI_COMPLETIONS'
   );

ALTER TABLE model_pool
  DROP CONSTRAINT IF EXISTS model_pool_recommended_surface_override_check;
ALTER TABLE model_pool
  ADD CONSTRAINT model_pool_recommended_surface_override_check CHECK (
    "recommendedSurfaceOverride" IS NULL
    OR "recommendedSurfaceOverride" IN (
      'OPENAI_CHAT_COMPLETIONS',
      'OPENAI_RESPONSES',
      'ANTHROPIC_MESSAGES',
      'OPENAI_COMPLETIONS'
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
END
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
END
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
END
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
  id, "createdAt", "updatedAt", "userId", label, "runtimeIdentityKey", "runtimeModel"
)
SELECT
  'cap_' || md5(target.id), target."createdAt", NOW(), target."userId",
  COALESCE(model."upstreamModelId", provider_model."upstreamModelId", target.id)
    || ' (' || target.id || ')',
  'execution-target:' || target.id,
  COALESCE(model."upstreamModelId", provider_model."upstreamModelId", target.id)
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
    id, "createdAt", "updatedAt", "userId", label, "runtimeIdentityKey", "runtimeModel"
  ) VALUES (
    capacity_id, NEW."createdAt", NOW(), NEW."userId",
    model_name || ' (' || NEW.id || ')',
    'execution-target:' || NEW.id, model_name
  ) ON CONFLICT ("userId", "runtimeIdentityKey") DO UPDATE
    SET "updatedAt" = EXCLUDED."updatedAt"
  RETURNING id INTO capacity_id;
  NEW."inferenceCapacityId" := capacity_id;
  RETURN NEW;
END
$create_target_capacity$;

DROP TRIGGER IF EXISTS execution_target_capacity_backfill ON execution_target;
CREATE TRIGGER execution_target_capacity_backfill
BEFORE INSERT ON execution_target
FOR EACH ROW EXECUTE FUNCTION create_execution_target_capacity();

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
END
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
     WHERE target."userId" <> record."userId"
        OR (record."targetDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM record."targetDiscoveredModelId")
    UNION ALL
    SELECT format('stickiness selection row=%s', record.id)
      FROM response_stickiness_record record
      JOIN execution_target target ON target.id = record."selectedExecutionTargetId"
     WHERE target."userId" <> record."userId"
        OR (record."selectedDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM record."selectedDiscoveredModelId")
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
     WHERE target."userId" <> request."userId"
        OR (request."selectedDiscoveredModelId" IS NOT NULL
            AND target."discoveredModelId" IS DISTINCT FROM request."selectedDiscoveredModelId")
  ) invalid;

  IF invalid_detail IS NOT NULL THEN
    RAISE EXCEPTION 'execution-target hardening found invalid pre-existing consumer references; reconcile these rows and retry'
      USING ERRCODE = '23514', DETAIL = invalid_detail,
            HINT = 'Correct the owner/target/type mismatch explicitly; hardening left the original rows unchanged.';
  END IF;
END
$invalid_consumers$;

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
END
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
      IF target_owner IS NULL OR target_owner <> NEW."userId"
         OR (NEW."selectedDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."selectedDiscoveredModelId") THEN
        RAISE EXCEPTION 'stickiness selection must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'relay_request' THEN
    IF NEW."requestedExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."requestedExecutionTargetId";
      IF target_owner IS NULL OR target_owner <> NEW."userId"
         OR (NEW."requestedDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."requestedDiscoveredModelId") THEN
        RAISE EXCEPTION 'relay request target must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."selectedExecutionTargetId" IS NOT NULL THEN
      SELECT "userId", "discoveredModelId" INTO target_owner, target_model
        FROM execution_target WHERE id = NEW."selectedExecutionTargetId";
      IF target_owner IS NULL OR target_owner <> NEW."userId"
         OR (NEW."selectedDiscoveredModelId" IS NOT NULL
             AND target_model IS DISTINCT FROM NEW."selectedDiscoveredModelId") THEN
        RAISE EXCEPTION 'relay request selection must match its owner and discovered model'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
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
  "selectedDiscoveredModelId", "selectedExecutionTargetId" ON response_stickiness_record
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

DROP TRIGGER IF EXISTS relay_request_execution_target_consistency ON relay_request;
CREATE TRIGGER relay_request_execution_target_consistency
BEFORE INSERT OR UPDATE OF "userId", "requestedDiscoveredModelId", "requestedExecutionTargetId",
  "selectedDiscoveredModelId", "selectedExecutionTargetId" ON relay_request
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_consumer_consistency();

COMMIT;
