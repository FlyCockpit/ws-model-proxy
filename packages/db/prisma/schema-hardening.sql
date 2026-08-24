-- Database invariants and compatibility backfills that Prisma cannot express.
-- This file is idempotent and is applied by the repository db:push wrappers.

BEGIN;

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

-- Collapse pre-existing mixed-representation duplicates before canonicalizing
-- legacy rows. The target-backed row is authoritative in the new model.
DELETE FROM pool_member AS legacy
USING execution_target AS target, pool_member AS canonical
WHERE legacy."executionTargetId" IS NULL
  AND legacy."discoveredModelId" = target."discoveredModelId"
  AND canonical."poolId" = legacy."poolId"
  AND canonical."executionTargetId" = target.id;

DELETE FROM model_api_token_allowlist_entry AS legacy
USING execution_target AS target, model_api_token_allowlist_entry AS canonical
WHERE legacy."executionTargetId" IS NULL
  AND legacy."discoveredModelId" = target."discoveredModelId"
  AND canonical."modelApiTokenId" = legacy."modelApiTokenId"
  AND canonical."executionTargetId" = target.id;

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

-- Canonicalize compatibility writes before uniqueness and consistency checks.
-- This closes the mixed-representation hole where one row used only the
-- legacy model FK and another used the execution-target FK for the same model.
CREATE OR REPLACE FUNCTION canonicalize_execution_target_consumer()
RETURNS trigger LANGUAGE plpgsql AS $canonicalize_consumer$
BEGIN
  IF NEW."executionTargetId" IS NULL AND NEW."discoveredModelId" IS NOT NULL THEN
    SELECT id INTO NEW."executionTargetId"
      FROM execution_target
     WHERE "discoveredModelId" = NEW."discoveredModelId";
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
         OR target_model IS NULL
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
         OR target_model IS NULL
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
         OR target_model IS NULL
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
         OR target_model IS NULL
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
