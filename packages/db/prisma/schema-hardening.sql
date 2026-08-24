-- Database invariants and compatibility backfills that Prisma cannot express.
-- This file is idempotent and is applied by the repository db:push wrappers.

BEGIN;

-- Serialize the compatibility cutover with old writers. PostgreSQL trigger DDL
-- also takes strong table locks, but taking every participating table up front
-- in parent-to-child order avoids observing a half-reconciled graph and gives
-- concurrent transactions one consistent lock order. An insert that committed
-- before these locks is included by the backfill below; one that starts after
-- the locks is released sees the installed trigger.
LOCK TABLE discovered_model, execution_target, model_pool, model_api_token,
  pool_member, model_api_token_allowlist_entry, response_stickiness_record,
  relay_request IN SHARE ROW EXCLUSIVE MODE;

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
