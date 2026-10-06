-- Database invariants Prisma cannot express, for the 0.4.0 schema (fresh baseline: no
-- backfills). Idempotent; applied by the repository db:push wrappers
-- (apply-schema-hardening.mjs) as ONE transaction. Plan and ownership per object:
-- docs/contracts/0.4.0-schema-hardening.md. Sections follow the Prisma files.

BEGIN;

-- DL-1 deploy lock order: this transaction takes EVERY table it touches in one statement, up
-- front, in the strongest mode any later statement needs (ACCESS EXCLUSIVE), with NOWAIT. It
-- never waits on a lock while holding one; a busy table fails the statement at once (55P03) and
-- apply-schema-hardening.mjs retries the whole transaction. verify-schema-hardening.mjs fails
-- when a table named anywhere in this file is missing here.
LOCK TABLE "user", session, node, node_credential, node_enrollment_code, node_audit_event,
  queued_node_command, runtime, runtime_version, runtime_model, runtime_share, runtime_instance,
  instance_rank, instance_step, runtime_operation, execution_target, profile, profile_node,
  profile_item, pool, pool_routing, pool_fallback, pool_advanced, pool_sidecar, pool_member,
  pool_routing_rule, api_key, api_key_pool, agent_token, share, provider_account, provider_model,
  provider_credential, provider_pricing_version, spend_cap, spend_reservation, spend_settlement,
  usage_ledger, attempt_event, runtime_load_minute, node_metrics_minute, audit_event,
  media_asset IN ACCESS EXCLUSIVE MODE NOWAIT;

-- Deploy writer (class D): every table is locked exclusively, so no fence can be contended. The
-- graph-write fence triggers accept any write while this transaction-local marker is set; only
-- this file and test fixtures set it.
SELECT set_config('wsmp.fences', ',*,', true);

-- Not a table: taken after the lock so the LOCK is the first statement.
CREATE SEQUENCE IF NOT EXISTS admission_enqueue_sequence AS bigint MINVALUE 0 START 1;

-- ═══════════════════════════════ Shared helpers ═══════════════════════════════

-- Validates a JSON object against an Advanced registry (packages/config pool-defaults.ts /
-- runtime-defaults.ts, emitted by scripts/registry-checks.mjs): only known keys, null means
-- automatic, every value of its kind and within its bounds; nested groups recurse.
CREATE OR REPLACE FUNCTION wsmp_registry_ok(value jsonb, registry jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $wsmp_registry_ok$
DECLARE
  key text;
  item jsonb;
  spec jsonb;
  number numeric;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' THEN
    RETURN false;
  END IF;
  FOR key, item IN SELECT * FROM jsonb_each(value) LOOP
    spec := registry -> key;
    IF spec IS NULL THEN
      RETURN false;
    END IF;
    CONTINUE WHEN jsonb_typeof(item) = 'null';
    IF NOT (spec ? 'kind') THEN
      IF NOT wsmp_registry_ok(item, spec) THEN
        RETURN false;
      END IF;
      CONTINUE;
    END IF;
    CASE spec ->> 'kind'
      WHEN 'bool' THEN
        IF jsonb_typeof(item) <> 'boolean' THEN RETURN false; END IF;
      WHEN 'enum' THEN
        IF jsonb_typeof(item) <> 'string' OR NOT ((spec -> 'values') ? (item #>> '{}')) THEN
          RETURN false;
        END IF;
      WHEN 'int', 'number' THEN
        IF jsonb_typeof(item) <> 'number' THEN RETURN false; END IF;
        number := (item #>> '{}')::numeric;
        IF (spec ->> 'kind') = 'int' AND number <> trunc(number) THEN RETURN false; END IF;
        IF number < (spec ->> 'min')::numeric OR number > (spec ->> 'max')::numeric THEN
          RETURN false;
        END IF;
      ELSE
        RETURN false;
    END CASE;
  END LOOP;
  RETURN true;
END;
$wsmp_registry_ok$;

CREATE OR REPLACE FUNCTION wsmp_jsonb_key_count(value jsonb)
RETURNS integer LANGUAGE sql IMMUTABLE AS $wsmp_jsonb_key_count$
  SELECT count(*)::integer FROM jsonb_object_keys(value)
$wsmp_jsonb_key_count$;

CREATE OR REPLACE FUNCTION reject_immutable_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $immutable_history$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$immutable_history$;

-- ═══════════════════════════════ auth ═══════════════════════════════

-- A session for a user (or an impersonating admin) whose deletion is pending is refused. Reads
-- the user rows FOR SHARE only (see the 0.4-dev rationale: no lock cycle with the mark/delete).
CREATE OR REPLACE FUNCTION refuse_session_for_deleting_user()
RETURNS trigger LANGUAGE plpgsql AS $session_refuse_deleting_user$
DECLARE
  pending boolean;
BEGIN
  SELECT u."deletionRequestedAt" IS NOT NULL INTO pending
    FROM "user" u WHERE u.id = NEW."userId" FOR SHARE;
  IF FOUND AND pending THEN
    RAISE EXCEPTION 'user deletion pending' USING ERRCODE = 'WMPD1';
  END IF;
  IF NEW."impersonatedBy" IS NOT NULL THEN
    SELECT u."deletionRequestedAt" IS NOT NULL INTO pending
      FROM "user" u WHERE u.id = NEW."impersonatedBy" FOR SHARE;
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

-- Single writer of the deletion marker: only the user-deletion subsystem (with the
-- transaction-local wsmp.user_deletion_writer = 'on') clears a pending deletion or rewrites
-- its generation.
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

-- ═══════════════════════════════ nodes ═══════════════════════════════

ALTER TABLE node DROP CONSTRAINT IF EXISTS node_shape_check;
ALTER TABLE node ADD CONSTRAINT node_shape_check CHECK (
  slug ~ '^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,62}$'
  AND cardinality(labels) <= 32
  AND "connectionGeneration" >= 0
  AND jsonb_typeof("heldDefinitions") = 'array'
  AND jsonb_array_length("heldDefinitions") <= 128
  AND ("heldMetricCommandsHash" IS NULL OR "heldMetricCommandsHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_port_range_check;
ALTER TABLE node ADD CONSTRAINT node_port_range_check CHECK (
  1024 <= "portStart" AND "portStart" <= "portEnd" AND "portEnd" <= 65535
);
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_trust_lower_shape;
ALTER TABLE node ADD CONSTRAINT node_trust_lower_shape CHECK (
  ("trustLowerRequestedAt" IS NULL) = ("trustLowerRequestedBy" IS NULL)
);
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_frozen_peers_shape;
ALTER TABLE node ADD CONSTRAINT node_frozen_peers_shape CHECK (
  "frozenPeers" IS NULL
  OR (trust = 'RELAY' AND jsonb_typeof("frozenPeers") = 'array'
      AND jsonb_array_length("frozenPeers") <= 128)
);
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_metric_commands_shape;
ALTER TABLE node ADD CONSTRAINT node_metric_commands_shape CHECK (
  jsonb_typeof("metricCommands") = 'array'
  AND jsonb_array_length("metricCommands") <= 16
  AND (("metricCommandsHash" IS NULL) = (jsonb_array_length("metricCommands") = 0))
  AND ("metricCommandsHash" IS NULL OR "metricCommandsHash" ~ '^[0-9a-f]{64}$')
);

-- One active credential per node; a new login revokes the old one in the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS node_credential_one_active
  ON node_credential ("nodeId") WHERE "revokedAt" IS NULL;

-- Not `usedAt ⇒ usedByNodeId`: deleting the node sets usedByNodeId null.
ALTER TABLE node_enrollment_code DROP CONSTRAINT IF EXISTS node_enrollment_code_shape;
ALTER TABLE node_enrollment_code ADD CONSTRAINT node_enrollment_code_shape CHECK (
  "expiresAt" <= "createdAt" + interval '7 days'
  AND "expiresAt" > "createdAt"
  AND length("codePrefix") = 8
  AND "codeDigest" ~ '^[0-9a-f]{64}$'
  AND ("usedByNodeId" IS NULL OR "usedAt" IS NOT NULL)
);
-- Single use, and a code only ever binds or replaces nodes of its owner.
CREATE OR REPLACE FUNCTION enforce_node_enrollment_code_use()
RETURNS trigger LANGUAGE plpgsql AS $node_enrollment_code_use$
BEGIN
  IF NEW."replaceNodeId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."replaceNodeId" IS DISTINCT FROM OLD."replaceNodeId")
     AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW."replaceNodeId" AND "userId" = NEW."userId") THEN
    RAISE EXCEPTION 'a replace code names a node of its owner' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedAt" IS NOT NULL OR NEW."usedByNodeId" IS NOT NULL THEN
      RAISE EXCEPTION 'an enrollment code is created unused' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."usedAt" IS NOT NULL THEN
    IF NEW."usedAt" IS DISTINCT FROM OLD."usedAt"
       OR (NEW."usedByNodeId" IS NOT NULL AND NEW."usedByNodeId" IS DISTINCT FROM OLD."usedByNodeId") THEN
      RAISE EXCEPTION 'an enrollment code is used once' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."usedAt" IS NOT NULL THEN
    IF NEW."usedByNodeId" IS NULL
       OR NOT EXISTS (SELECT 1 FROM node WHERE id = NEW."usedByNodeId" AND "userId" = NEW."userId") THEN
      RAISE EXCEPTION 'a used enrollment code names a node of its owner' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."usedByNodeId" IS NOT NULL THEN
    RAISE EXCEPTION 'usedByNodeId is set with usedAt' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$node_enrollment_code_use$;
DROP TRIGGER IF EXISTS node_enrollment_code_use ON node_enrollment_code;
CREATE TRIGGER node_enrollment_code_use BEFORE INSERT OR UPDATE ON node_enrollment_code
FOR EACH ROW EXECUTE FUNCTION enforce_node_enrollment_code_use();

-- Deleting a node (spec §3.4/§3.5, item 20): refused with a clear reason while a profile pins
-- one of its always-on runtimes; otherwise every reservation there is released (proof is
-- impossible without the node), its open steps end, instances with a part there are stopped
-- (the reconciler stops the surviving parts and deletes the instance once all are released),
-- and its always-on runtimes go (instance first: the instance → runtime FK is NoAction).
CREATE OR REPLACE FUNCTION node_delete_release()
RETURNS trigger LANGUAGE plpgsql AS $node_delete_release$
BEGIN
  IF EXISTS (
    SELECT 1 FROM profile_item pi JOIN runtime r ON r.id = pi."runtimeId" WHERE r."nodeId" = OLD.id
  ) THEN
    RAISE EXCEPTION 'pinned_by_profile: a profile pins an always-on runtime on this node'
      USING ERRCODE = 'WMPP1';
  END IF;
  UPDATE instance_step
     SET state = CASE WHEN attempts = 0 AND state = 'PENDING' THEN 'CANCELLED'::"StepState"
                      ELSE 'FAILED'::"StepState" END,
         "errorCode" = CASE WHEN attempts = 0 AND state = 'PENDING' THEN "errorCode" ELSE 'node_deleted' END,
         "operatorTerminalId" = NULL, "operatorSince" = NULL, "operatorAcceptedAt" = NULL,
         "operatorLastExit" = NULL, "operatorHold" = NULL, deadline = NULL, "leaseExpiresAt" = NULL
   WHERE "nodeId" = OLD.id AND state IN ('PENDING', 'RUNNING', 'AWAITING_OPERATOR');
  UPDATE runtime_instance i
     SET "desiredState" = 'STOPPED', phase = 'STOPPING', "phaseReason" = 'node_deleted',
         "phaseChangedAt" = now(), "needsOperator" = NULL, "needsOperatorSince" = NULL
   WHERE i."desiredState" IS NOT NULL AND i.phase <> 'STOPPED'
     AND EXISTS (SELECT 1 FROM instance_rank r WHERE r."instanceId" = i.id AND r."nodeId" = OLD.id);
  UPDATE instance_rank
     SET claim = 'RELEASED', "claimChangedAt" = now(), "stoppedAt" = COALESCE("stoppedAt", now())
   WHERE "nodeId" = OLD.id AND claim <> 'RELEASED';
  DELETE FROM runtime_instance -- policy: bounded-delete
   WHERE "runtimeId" IN (SELECT id FROM runtime WHERE "nodeId" = OLD.id);
  RETURN OLD;
END;
$node_delete_release$;
DROP TRIGGER IF EXISTS node_delete_release ON node;
CREATE TRIGGER node_delete_release BEFORE DELETE ON node
FOR EACH ROW EXECUTE FUNCTION node_delete_release();

-- Audit: plain ids, no foreign keys, no command text; UPDATE refused, DELETE kept for the
-- user-deletion drain and the 90-day retention sweep.
ALTER TABLE node_audit_event DROP CONSTRAINT IF EXISTS node_audit_event_shape;
ALTER TABLE node_audit_event ADD CONSTRAINT node_audit_event_shape CHECK (
  length("userId") BETWEEN 1 AND 128
  AND length("nodeId") BETWEEN 1 AND 128
  AND length(subject) BETWEEN 1 AND 4096
  AND (rank IS NULL OR rank BETWEEN 0 AND 63)
  AND ("exitCode" IS NULL OR "exitCode" BETWEEN 0 AND 255)
  AND (actor = 'AGENT') = ("agentTokenId" IS NOT NULL)
  AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
);
DROP TRIGGER IF EXISTS node_audit_event_append_only ON node_audit_event;
CREATE TRIGGER node_audit_event_append_only BEFORE UPDATE ON node_audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();

ALTER TABLE queued_node_command DROP CONSTRAINT IF EXISTS queued_node_command_shape;
ALTER TABLE queued_node_command ADD CONSTRAINT queued_node_command_shape CHECK (
  octet_length(command) BETWEEN 1 AND 16384
  AND (note IS NULL OR octet_length(note) <= 2000)
  AND "expiresAt" > "createdAt"
  AND "expiresAt" <= "createdAt" + interval '7 days'
  AND (state = 'QUEUED') = ("decidedAt" IS NULL)
  AND (state = 'QUEUED' OR "decidedBy" IS NOT NULL OR state = 'EXPIRED')
);
-- QUEUED → RUN | DISMISSED | EXPIRED | REFUSED, once; the text never changes.
CREATE OR REPLACE FUNCTION enforce_queued_node_command_transition()
RETURNS trigger LANGUAGE plpgsql AS $queued_node_command_transition$
BEGIN
  IF (NEW.command, NEW.note, NEW."nodeId", NEW."userId", NEW."agentTokenId", NEW."expiresAt")
     IS DISTINCT FROM (OLD.command, OLD.note, OLD."nodeId", OLD."userId", OLD."agentTokenId", OLD."expiresAt") THEN
    RAISE EXCEPTION 'a queued command is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'QUEUED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a queued command is decided once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$queued_node_command_transition$;
DROP TRIGGER IF EXISTS queued_node_command_transition ON queued_node_command;
CREATE TRIGGER queued_node_command_transition BEFORE UPDATE ON queued_node_command
FOR EACH ROW EXECUTE FUNCTION enforce_queued_node_command_transition();

-- ═══════════════════════════════ runtimes ═══════════════════════════════

ALTER TABLE runtime DROP CONSTRAINT IF EXISTS runtime_kind_shape_check;
ALTER TABLE runtime ADD CONSTRAINT runtime_kind_shape_check CHECK (
  (kind = 'ALWAYS_ON') = ("nodeId" IS NOT NULL)
  AND slug ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$'
  AND slug !~ '^i-[a-z0-9]{12}$'
  AND length(btrim(name)) BETWEEN 1 AND 120
);

-- The api/engine/modelType columns are copies of the spec (B2); the spec is one kind.
ALTER TABLE runtime_version DROP CONSTRAINT IF EXISTS runtime_version_derived_columns;
ALTER TABLE runtime_version ADD CONSTRAINT runtime_version_derived_columns CHECK (
  jsonb_typeof(spec) = 'object'
  AND api::text = upper(spec ->> 'api')
  AND engine::text = upper(spec ->> 'engine')
  AND "modelType"::text = upper(spec ->> 'modelType')
  AND (spec ? 'launch') <> (spec ? 'address')
  AND "launchHash" ~ '^[0-9a-f]{64}$'
  AND "contentHash" ~ '^[0-9a-f]{64}$'
  AND version >= 1
  AND (editor = 'AGENT') = ("agentTokenId" IS NOT NULL)
  AND (note IS NULL OR length(note) BETWEEN 1 AND 500)
  AND octet_length(spec::text) <= 65536
);

-- Versions are immutable; numbers only grow; a version's kind is its runtime's kind.
CREATE OR REPLACE FUNCTION enforce_runtime_version_rules()
RETURNS trigger LANGUAGE plpgsql AS $runtime_version_rules$
DECLARE
  runtime_kind text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'runtime versions are immutable' USING ERRCODE = '55000';
  END IF;
  SELECT kind::text INTO runtime_kind FROM runtime WHERE id = NEW."runtimeId";
  IF (runtime_kind = 'STARTABLE') <> (NEW.spec ? 'launch') THEN
    RAISE EXCEPTION 'a version has its runtime''s kind' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM runtime_version WHERE "runtimeId" = NEW."runtimeId" AND version >= NEW.version) THEN
    RAISE EXCEPTION 'version numbers increase' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$runtime_version_rules$;
DROP TRIGGER IF EXISTS runtime_version_immutable ON runtime_version;
CREATE TRIGGER runtime_version_immutable BEFORE INSERT OR UPDATE ON runtime_version
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_version_rules();

CREATE OR REPLACE FUNCTION enforce_runtime_current_version()
RETURNS trigger LANGUAGE plpgsql AS $runtime_current_version$
BEGIN
  IF NEW."currentVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM runtime_version WHERE id = NEW."currentVersionId" AND "runtimeId" = NEW.id
  ) THEN
    RAISE EXCEPTION 'currentVersionId belongs to the runtime' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'a runtime keeps its kind' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$runtime_current_version$;
DROP TRIGGER IF EXISTS runtime_current_version_consistency ON runtime;
CREATE CONSTRAINT TRIGGER runtime_current_version_consistency
AFTER INSERT OR UPDATE OF "currentVersionId", kind ON runtime
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_runtime_current_version();

ALTER TABLE runtime_model DROP CONSTRAINT IF EXISTS runtime_model_shape_check;
ALTER TABLE runtime_model ADD CONSTRAINT runtime_model_shape_check CHECK (
  octet_length("upstreamModelId") BETWEEN 1 AND 256
  AND "upstreamModelId" = btrim("upstreamModelId")
  AND (NOT "capabilitiesOverridden" OR cardinality(capabilities) >= 0)
  AND ("embeddingContract" IS NULL OR jsonb_typeof("embeddingContract") = 'object')
  AND ("transcriptionProfile" IS NULL OR jsonb_typeof("transcriptionProfile") = 'object')
);

ALTER TABLE runtime_share DROP CONSTRAINT IF EXISTS runtime_share_shape;
ALTER TABLE runtime_share ADD CONSTRAINT runtime_share_shape CHECK ("ownerUserId" <> "granteeUserId");

-- Exactly one instance per always-on runtime.
CREATE UNIQUE INDEX IF NOT EXISTS runtime_one_always_on_instance
  ON runtime_instance ("runtimeId") WHERE "desiredState" IS NULL;

ALTER TABLE runtime_instance DROP CONSTRAINT IF EXISTS runtime_instance_shape;
ALTER TABLE runtime_instance ADD CONSTRAINT runtime_instance_shape CHECK (
  handle ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$'
  AND ("desiredState" IS NOT NULL OR phase IN ('READY', 'UNHEALTHY', 'UNAVAILABLE'))
  AND ("desiredState" IS NULL OR handle ~ '^i-[a-z0-9]{12}$')
  AND "restartsInWindow" >= 0
  AND "healthFailures" >= 0 AND "healthSuccesses" >= 0
  AND ("engineSlots" IS NULL OR "engineSlots" > 0)
  AND ("observedKvBudgetTokens" IS NULL OR "observedKvBudgetTokens" > 0)
  AND ("maxModelLen" IS NULL OR "maxModelLen" > 0)
  AND ("phaseReason" IS NULL OR "phaseReason" ~ '^[a-z0-9_]{1,64}$')
);
ALTER TABLE runtime_instance DROP CONSTRAINT IF EXISTS runtime_instance_notify_failures;
ALTER TABLE runtime_instance ADD CONSTRAINT runtime_instance_notify_failures
  CHECK ("needsOperatorNotifyFailures" BETWEEN 0 AND 1000);
-- needsOperator and its timestamp travel together; RESTART only for an instance that should
-- run and has stopped; FORGET only while STOPPING.
ALTER TABLE runtime_instance DROP CONSTRAINT IF EXISTS runtime_instance_operator_shape;
ALTER TABLE runtime_instance ADD CONSTRAINT runtime_instance_operator_shape CHECK (
  ("needsOperator" IS NULL) = ("needsOperatorSince" IS NULL)
  AND ("needsOperator" IS DISTINCT FROM 'RESTART'
       OR ("desiredState" = 'RUNNING' AND phase IN ('STOPPED', 'FAILED')))
  AND ("needsOperator" IS DISTINCT FROM 'FORGET' OR phase = 'STOPPING')
);
-- The admission view (versionId) and the launched version belong to the instance's runtime and
-- share one launch hash (live adoption never changes what runs).
CREATE OR REPLACE FUNCTION enforce_runtime_instance_versions()
RETURNS trigger LANGUAGE plpgsql AS $runtime_instance_versions$
DECLARE
  admission_hash text;
  launch_hash text;
BEGIN
  SELECT "launchHash" INTO admission_hash FROM runtime_version
   WHERE id = NEW."versionId" AND "runtimeId" = NEW."runtimeId";
  SELECT "launchHash" INTO launch_hash FROM runtime_version
   WHERE id = NEW."launchVersionId" AND "runtimeId" = NEW."runtimeId";
  IF admission_hash IS NULL OR launch_hash IS NULL OR admission_hash <> launch_hash THEN
    RAISE EXCEPTION 'instance versions belong to its runtime and share one launch hash'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."runtimeId", NEW."userId", NEW.handle)
     IS DISTINCT FROM (OLD."runtimeId", OLD."userId", OLD.handle) THEN
    RAISE EXCEPTION 'instance identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$runtime_instance_versions$;
DROP TRIGGER IF EXISTS runtime_instance_launch_version ON runtime_instance;
CREATE TRIGGER runtime_instance_launch_version
BEFORE INSERT OR UPDATE OF "versionId", "launchVersionId", "runtimeId", "userId", handle ON runtime_instance
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_instance_versions();

ALTER TABLE instance_rank DROP CONSTRAINT IF EXISTS instance_rank_bounds;
ALTER TABLE instance_rank ADD CONSTRAINT instance_rank_bounds CHECK (
  rank BETWEEN 0 AND 63
  AND port BETWEEN 1024 AND 65535
  AND ("distPort" IS NULL OR "distPort" BETWEEN 1024 AND 65535)
  AND "unitName" ~ '^wsmp-[a-z0-9-]{1,41}-r[0-9]{1,2}$'
  AND "unitName" LIKE '%-r' || rank::text
  AND jsonb_typeof(resources) = 'object'
);
-- HELD and HELD_UNKNOWN keep their port reserved.
CREATE UNIQUE INDEX IF NOT EXISTS instance_rank_reserved_port
  ON instance_rank ("nodeId", port) WHERE claim <> 'RELEASED';
ALTER TABLE instance_rank DROP CONSTRAINT IF EXISTS instance_rank_claim_shape;
ALTER TABLE instance_rank ADD CONSTRAINT instance_rank_claim_shape CHECK (
  (claim <> 'HELD_UNKNOWN' OR "forgottenAt" IS NOT NULL)
  AND (claim <> 'RELEASED' OR "stoppedAt" IS NOT NULL)
  AND ("forgottenAt" IS NULL) = ("forgottenBy" IS NULL)
);
-- The held-unknown probe sweep pages these rows by id.
CREATE INDEX IF NOT EXISTS instance_rank_held_unknown_id
  ON instance_rank (id) WHERE claim = 'HELD_UNKNOWN';

ALTER TABLE instance_step DROP CONSTRAINT IF EXISTS instance_step_shape;
ALTER TABLE instance_step ADD CONSTRAINT instance_step_shape CHECK (
  rank BETWEEN 0 AND 63
  AND sequence >= 0 AND generation >= 0 AND attempts >= 0
  AND "intentHash" ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(intent) = 'object'
  AND (state <> 'CANCELLED' OR attempts = 0)
  AND ("errorCode" IS NULL OR "errorCode" ~ '^[a-z0-9_]{1,64}$')
);
-- Operator terminals of interactive steps: only on prepare/start/after_join/stop; a terminal id
-- only while AWAITING_OPERATOR or RUNNING; AWAITING_OPERATOR has an open time and no deadline;
-- PENDING carries no operator state.
ALTER TABLE instance_step DROP CONSTRAINT IF EXISTS instance_step_operator_shape;
ALTER TABLE instance_step ADD CONSTRAINT instance_step_operator_shape CHECK (
  ("operatorTerminalId" IS NULL
    OR (state IN ('AWAITING_OPERATOR', 'RUNNING') AND length("operatorTerminalId") BETWEEN 1 AND 128))
  AND (state <> 'AWAITING_OPERATOR' OR ("operatorSince" IS NOT NULL AND deadline IS NULL))
  AND ("operatorAcceptedAt" IS NULL OR "operatorSince" IS NOT NULL)
  AND ("operatorLastExit" IS NULL OR "operatorSince" IS NOT NULL)
  AND (state <> 'PENDING' OR ("operatorTerminalId" IS NULL AND "operatorSince" IS NULL
    AND "operatorAcceptedAt" IS NULL AND "operatorLastExit" IS NULL))
  AND (("operatorTerminalId" IS NULL AND "operatorSince" IS NULL)
    OR phase IN ('PREPARE', 'START', 'AFTER_JOIN', 'STOP'))
);
ALTER TABLE instance_step DROP CONSTRAINT IF EXISTS instance_step_operator_hold;
ALTER TABLE instance_step ADD CONSTRAINT instance_step_operator_hold CHECK (
  "operatorHold" IS NULL
  OR (state = 'PENDING' AND "operatorHold" IN
    ('operator_capability_missing', 'operator_session_full', 'operator_node_full'))
);

ALTER TABLE runtime_operation DROP CONSTRAINT IF EXISTS runtime_operation_shape;
ALTER TABLE runtime_operation ADD CONSTRAINT runtime_operation_shape CHECK (
  (actor = 'AGENT') = ("agentTokenId" IS NOT NULL)
  AND (kind = 'PROFILE_APPLY') = ("profileId" IS NOT NULL)
  AND fingerprint ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(summary) = 'object'
);

-- One model on one instance, or one provider model.
ALTER TABLE execution_target DROP CONSTRAINT IF EXISTS execution_target_kind_source_xor_check;
ALTER TABLE execution_target ADD CONSTRAINT execution_target_kind_source_xor_check CHECK (
  (kind = 'INSTANCE_MODEL' AND "instanceId" IS NOT NULL AND "runtimeModelId" IS NOT NULL
    AND "providerModelId" IS NULL)
  OR (kind = 'PROVIDER_MODEL' AND "providerModelId" IS NOT NULL AND "instanceId" IS NULL
    AND "runtimeModelId" IS NULL)
);
CREATE OR REPLACE FUNCTION enforce_execution_target_identity()
RETURNS trigger LANGUAGE plpgsql AS $execution_target_identity$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (NEW.id, NEW."userId", NEW.kind, NEW."instanceId", NEW."runtimeModelId", NEW."providerModelId")
     IS DISTINCT FROM
     (OLD.id, OLD."userId", OLD.kind, OLD."instanceId", OLD."runtimeModelId", OLD."providerModelId") THEN
    RAISE EXCEPTION 'execution target identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.kind = 'INSTANCE_MODEL' AND NOT EXISTS (
    SELECT 1 FROM runtime_instance i JOIN runtime_model m ON m."runtimeId" = i."runtimeId"
     WHERE i.id = NEW."instanceId" AND m.id = NEW."runtimeModelId"
  ) THEN
    RAISE EXCEPTION 'a target pairs an instance with a model of the same runtime' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$execution_target_identity$;
DROP TRIGGER IF EXISTS execution_target_identity_immutable ON execution_target;
CREATE TRIGGER execution_target_identity_immutable BEFORE INSERT OR UPDATE ON execution_target
FOR EACH ROW EXECUTE FUNCTION enforce_execution_target_identity();

-- ═══════════════════════════════ profiles ═══════════════════════════════

ALTER TABLE profile DROP CONSTRAINT IF EXISTS profile_shape;
ALTER TABLE profile ADD CONSTRAINT profile_shape CHECK (
  slug ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$'
  AND length(btrim(name)) BETWEEN 1 AND 120
);
ALTER TABLE profile_item DROP CONSTRAINT IF EXISTS profile_item_shape;
ALTER TABLE profile_item ADD CONSTRAINT profile_item_shape CHECK (
  position BETWEEN 0 AND 63 AND count BETWEEN 1 AND 64 AND cardinality("nodeIds") <= 64
);
-- Profile nodes and items belong to the profile owner; an item's version is of its runtime;
-- an item's node subset is within the profile's nodes.
CREATE OR REPLACE FUNCTION enforce_profile_owner_consistency()
RETURNS trigger LANGUAGE plpgsql AS $profile_owner_consistency$
DECLARE
  owner text;
BEGIN
  SELECT "userId" INTO owner FROM profile WHERE id = NEW."profileId";
  IF owner IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'profile_node' THEN
    IF NOT EXISTS (SELECT 1 FROM node WHERE id = NEW."nodeId" AND "userId" = owner) THEN
      RAISE EXCEPTION 'a profile owns only its owner''s nodes' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM runtime r JOIN runtime_version v ON v."runtimeId" = r.id
       WHERE r.id = NEW."runtimeId" AND r."userId" = owner AND v.id = NEW."versionId"
    ) THEN
      RAISE EXCEPTION 'a profile item pins a version of its owner''s runtime' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM unnest(NEW."nodeIds") AS listed(node_id)
       WHERE NOT EXISTS (
         SELECT 1 FROM profile_node pn WHERE pn."profileId" = NEW."profileId" AND pn."nodeId" = listed.node_id)
    ) THEN
      RAISE EXCEPTION 'a profile item names only the profile''s nodes' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$profile_owner_consistency$;
DROP TRIGGER IF EXISTS profile_owner_consistency ON profile_node;
CREATE CONSTRAINT TRIGGER profile_owner_consistency AFTER INSERT OR UPDATE ON profile_node
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_profile_owner_consistency();
DROP TRIGGER IF EXISTS profile_owner_consistency ON profile_item;
CREATE CONSTRAINT TRIGGER profile_owner_consistency AFTER INSERT OR UPDATE ON profile_item
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_profile_owner_consistency();

-- ═══════════════════════════════ pools ═══════════════════════════════

ALTER TABLE pool DROP CONSTRAINT IF EXISTS pool_shape;
ALTER TABLE pool ADD CONSTRAINT pool_shape CHECK (
  slug ~ '^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$'
  AND length(btrim(name)) BETWEEN 1 AND 120
  AND (description IS NULL OR length(description) <= 2000)
);

-- Every pool has its Routing, Cloud and Advanced rows.
CREATE OR REPLACE FUNCTION create_pool_children()
RETURNS trigger LANGUAGE plpgsql AS $pool_create_children$
BEGIN
  INSERT INTO pool_routing ("poolId") VALUES (NEW.id);
  INSERT INTO pool_fallback ("poolId") VALUES (NEW.id);
  INSERT INTO pool_advanced ("poolId") VALUES (NEW.id);
  RETURN NULL;
END;
$pool_create_children$;
DROP TRIGGER IF EXISTS pool_create_children ON pool;
CREATE TRIGGER pool_create_children AFTER INSERT ON pool
FOR EACH ROW EXECUTE FUNCTION create_pool_children();

CREATE OR REPLACE FUNCTION enforce_pool_owner_immutable()
RETURNS trigger LANGUAGE plpgsql AS $pool_owner_immutable$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."modelType" IS DISTINCT FROM OLD."modelType" THEN
    RAISE EXCEPTION 'a pool keeps its owner and model type' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$pool_owner_immutable$;
DROP TRIGGER IF EXISTS pool_owner_immutable ON pool;
CREATE TRIGGER pool_owner_immutable BEFORE UPDATE OF "userId", "modelType" ON pool
FOR EACH ROW EXECUTE FUNCTION enforce_pool_owner_immutable();

ALTER TABLE pool_routing DROP CONSTRAINT IF EXISTS pool_routing_policy_check;
ALTER TABLE pool_routing ADD CONSTRAINT pool_routing_policy_check CHECK (
  ("concurrencyLimit" IS NULL OR "concurrencyLimit" BETWEEN 1 AND 100000)
  AND "keptSlots" BETWEEN 0 AND 10000
);
ALTER TABLE pool_fallback DROP CONSTRAINT IF EXISTS pool_fallback_shape;
ALTER TABLE pool_fallback ADD CONSTRAINT pool_fallback_shape CHECK (
  ("embeddingContract" IS NULL OR jsonb_typeof("embeddingContract") = 'object')
  AND ("ownKeyEquivalentModel" IS NULL OR length(btrim("ownKeyEquivalentModel")) BETWEEN 1 AND 256)
);

ALTER TABLE pool_member DROP CONSTRAINT IF EXISTS pool_member_kind_shape_check;
ALTER TABLE pool_member ADD CONSTRAINT pool_member_kind_shape_check CHECK (
  ((kind = 'LOCAL' AND "runtimeModelId" IS NOT NULL AND "providerModelId" IS NULL AND "cloudOrder" IS NULL)
    OR (kind = 'CLOUD' AND "providerModelId" IS NOT NULL AND "runtimeModelId" IS NULL
        AND "cloudOrder" IS NOT NULL AND "shareId" IS NULL))
  AND weight BETWEEN 1 AND 1000
  AND ("cloudOrder" IS NULL OR "cloudOrder" BETWEEN 0 AND 15)
);
CREATE UNIQUE INDEX IF NOT EXISTS pool_member_cloud_order_unique
  ON pool_member ("poolId", "cloudOrder") WHERE kind = 'CLOUD';

-- Where a member comes from: LOCAL = a served model of the pool owner (no share), or of the
-- grantee of a share of THIS pool with canContribute (refused while ownHardwareOnly); CLOUD = a
-- provider model of the pool owner. Model types always match the pool.
CREATE OR REPLACE FUNCTION enforce_pool_member_source()
RETURNS trigger LANGUAGE plpgsql AS $pool_member_source$
DECLARE
  pool_owner text;
  pool_type text;
  model_owner text;
  model_type text;
BEGIN
  SELECT "userId", "modelType"::text INTO pool_owner, pool_type FROM pool WHERE id = NEW."poolId";
  IF NEW.kind = 'LOCAL' THEN
    SELECT "userId", type::text INTO model_owner, model_type FROM runtime_model WHERE id = NEW."runtimeModelId";
    IF NEW."shareId" IS NULL THEN
      IF model_owner IS DISTINCT FROM pool_owner THEN
        RAISE EXCEPTION 'a member without a share is the pool owner''s served model' USING ERRCODE = '23514';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM share s WHERE s.id = NEW."shareId" AND s."poolId" = NEW."poolId"
         AND s."granteeUserId" = model_owner AND s."canContribute"
    ) THEN
      RAISE EXCEPTION 'a contributed member needs a can-contribute share of this pool' USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1 FROM pool_routing WHERE "poolId" = NEW."poolId" AND "ownHardwareOnly"
    ) THEN
      RAISE EXCEPTION 'this pool routes to its owner''s hardware only' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "userId", type::text INTO model_owner, model_type FROM provider_model WHERE id = NEW."providerModelId";
    IF model_owner IS DISTINCT FROM pool_owner THEN
      RAISE EXCEPTION 'a cloud member is the pool owner''s provider model' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF model_type IS DISTINCT FROM pool_type THEN
    RAISE EXCEPTION 'member model type must equal the pool type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$pool_member_source$;
DROP TRIGGER IF EXISTS pool_member_source ON pool_member;
CREATE TRIGGER pool_member_source
BEFORE INSERT OR UPDATE OF kind, "poolId", "runtimeModelId", "providerModelId", "shareId" ON pool_member
FOR EACH ROW EXECUTE FUNCTION enforce_pool_member_source();

-- Sidecars: another pool of the owner (or shared with the owner with can use), of the right type,
-- never the pool itself, and never a chain (a target has no sidecar for the same input).
CREATE OR REPLACE FUNCTION enforce_pool_sidecar_target()
RETURNS trigger LANGUAGE plpgsql AS $pool_sidecar_target$
DECLARE
  owner text;
  target_owner text;
  target_type text;
BEGIN
  IF NEW."targetPoolId" = NEW."poolId" THEN
    RAISE EXCEPTION 'a pool is not its own sidecar' USING ERRCODE = '23514';
  END IF;
  SELECT "userId" INTO owner FROM pool WHERE id = NEW."poolId";
  SELECT "userId", "modelType"::text INTO target_owner, target_type FROM pool WHERE id = NEW."targetPoolId";
  IF target_owner IS DISTINCT FROM owner AND NOT EXISTS (
    SELECT 1 FROM share WHERE "poolId" = NEW."targetPoolId" AND "granteeUserId" = owner AND "canUse"
  ) THEN
    RAISE EXCEPTION 'a sidecar is a pool you own or may use' USING ERRCODE = '23514';
  END IF;
  IF (NEW.input = 'AUDIO') <> (target_type = 'TRANSCRIPTION')
     OR (NEW.input IN ('IMAGE', 'VIDEO') AND target_type <> 'LLM') THEN
    RAISE EXCEPTION 'sidecar target type does not fit the input' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM pool_sidecar WHERE "poolId" = NEW."targetPoolId" AND input = NEW.input) THEN
    RAISE EXCEPTION 'sidecars do not chain' USING ERRCODE = '23514';
  END IF;
  IF (NEW."timeoutMs" IS NOT NULL AND NEW."timeoutMs" NOT BETWEEN 1000 AND 600000)
     OR (NEW."maxAssets" IS NOT NULL AND NEW."maxAssets" NOT BETWEEN 1 AND 64)
     OR (NEW.prompt IS NOT NULL AND length(NEW.prompt) > 8000) THEN
    RAISE EXCEPTION 'sidecar limits out of range' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$pool_sidecar_target$;
DROP TRIGGER IF EXISTS pool_sidecar_target_check ON pool_sidecar;
CREATE TRIGGER pool_sidecar_target_check BEFORE INSERT OR UPDATE ON pool_sidecar
FOR EACH ROW EXECUTE FUNCTION enforce_pool_sidecar_target();

-- Routing rules: at most 16 per pool; a member-scoped rule names a LOCAL member of its pool.
-- Targeted rules go with their member; exclude rules become pool-wide.
ALTER TABLE pool_routing_rule DROP CONSTRAINT IF EXISTS pool_routing_rule_shape_check;
ALTER TABLE pool_routing_rule ADD CONSTRAINT pool_routing_rule_shape_check CHECK (
  position BETWEEN 0 AND 15
  AND metric ~ '^[A-Za-z0-9_.:-]{1,64}$'
  AND aggregate IN ('max', 'min', 'avg')
  AND op IN ('>', '>=', '<', '<=')
  AND effect IN ('full', 'avoid')
  AND "threshold" = "threshold"
  AND "threshold" BETWEEN -1e308 AND 1e308
  AND (NOT exclude OR "memberId" IS NOT NULL)
  AND (labels IS NULL OR jsonb_typeof(labels) = 'object')
);
CREATE OR REPLACE FUNCTION enforce_pool_routing_rule_member()
RETURNS trigger LANGUAGE plpgsql AS $pool_routing_rule_member$
BEGIN
  IF NEW."memberId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM pool_member WHERE id = NEW."memberId" AND "poolId" = NEW."poolId" AND kind = 'LOCAL'
  ) THEN
    RAISE EXCEPTION 'pool routing rule member must be a LOCAL member of the pool' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$pool_routing_rule_member$;
DROP TRIGGER IF EXISTS pool_routing_rule_member ON pool_routing_rule;
CREATE TRIGGER pool_routing_rule_member BEFORE INSERT OR UPDATE OF "poolId", "memberId" ON pool_routing_rule
FOR EACH ROW EXECUTE FUNCTION enforce_pool_routing_rule_member();
CREATE OR REPLACE FUNCTION pool_routing_rule_on_member_delete()
RETURNS trigger LANGUAGE plpgsql AS $pool_routing_rule_on_member_delete$
BEGIN
  DELETE FROM pool_routing_rule WHERE "memberId" = OLD.id AND exclude IS NOT TRUE; -- policy: bounded-delete
  UPDATE pool_routing_rule SET "memberId" = NULL, exclude = false
   WHERE "memberId" = OLD.id AND exclude IS TRUE;
  RETURN OLD;
END;
$pool_routing_rule_on_member_delete$;
DROP TRIGGER IF EXISTS pool_routing_rule_on_member_delete ON pool_member;
CREATE TRIGGER pool_routing_rule_on_member_delete BEFORE DELETE ON pool_member
FOR EACH ROW EXECUTE FUNCTION pool_routing_rule_on_member_delete();

-- ═══════════════════════════════ access ═══════════════════════════════

ALTER TABLE api_key DROP CONSTRAINT IF EXISTS api_key_shape;
ALTER TABLE api_key ADD CONSTRAINT api_key_shape CHECK (
  length(btrim(name)) BETWEEN 1 AND 120
  AND length("lookupPrefix") BETWEEN 8 AND 64
  AND "secretDigest" ~ '^[0-9a-f]{64}$'
  AND ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
);
ALTER TABLE agent_token DROP CONSTRAINT IF EXISTS agent_token_shape;
ALTER TABLE agent_token ADD CONSTRAINT agent_token_shape CHECK (
  length(btrim(name)) BETWEEN 1 AND 120
  AND length("lookupPrefix") BETWEEN 8 AND 64
  AND "secretDigest" ~ '^[0-9a-f]{64}$'
  AND ("expiresAt" IS NULL OR "expiresAt" > "createdAt")
);

ALTER TABLE share DROP CONSTRAINT IF EXISTS share_shape;
ALTER TABLE share ADD CONSTRAINT share_shape CHECK (
  "ownerUserId" <> "granteeUserId"
  AND ("protectionPercent" IS NULL OR "protectionPercent" BETWEEN 0 AND 100)
);
ALTER TABLE share DROP CONSTRAINT IF EXISTS share_permission_shape;
ALTER TABLE share ADD CONSTRAINT share_permission_shape CHECK ("canUse" OR "canContribute");

-- The grantee's own-key model is the grantee's; clearing canContribute removes the members the
-- share contributed; clearing canUse removes the grantee's API-key entries for the pool.
CREATE OR REPLACE FUNCTION enforce_share_consistency()
RETURNS trigger LANGUAGE plpgsql AS $share_consistency$
BEGIN
  IF NEW."ownKeyProviderModelId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM provider_model WHERE id = NEW."ownKeyProviderModelId" AND "userId" = NEW."granteeUserId"
  ) THEN
    RAISE EXCEPTION 'the own-key model belongs to the share holder' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."canContribute" AND NOT NEW."canContribute" THEN
      DELETE FROM pool_member WHERE "shareId" = NEW.id; -- policy: bounded-delete
    END IF;
    IF OLD."canUse" AND NOT NEW."canUse" THEN
      DELETE FROM api_key_pool kp USING api_key k -- policy: bounded-delete
       WHERE kp."apiKeyId" = k.id AND k."userId" = NEW."granteeUserId" AND kp."poolId" = NEW."poolId";
    END IF;
  END IF;
  RETURN NEW;
END;
$share_consistency$;
DROP TRIGGER IF EXISTS share_consistency ON share;
CREATE TRIGGER share_consistency
BEFORE INSERT OR UPDATE OF "ownKeyProviderModelId", "canContribute", "canUse" ON share
FOR EACH ROW EXECUTE FUNCTION enforce_share_consistency();
CREATE OR REPLACE FUNCTION share_delete_cleanup()
RETURNS trigger LANGUAGE plpgsql AS $share_delete_cleanup$
BEGIN
  DELETE FROM api_key_pool kp USING api_key k -- policy: bounded-delete
   WHERE kp."apiKeyId" = k.id AND k."userId" = OLD."granteeUserId" AND kp."poolId" = OLD."poolId";
  RETURN OLD;
END;
$share_delete_cleanup$;
DROP TRIGGER IF EXISTS share_delete_cleanup ON share;
CREATE TRIGGER share_delete_cleanup BEFORE DELETE ON share
FOR EACH ROW EXECUTE FUNCTION share_delete_cleanup();

-- An API key lists only pools its owner owns or may use (share with canUse).
CREATE OR REPLACE FUNCTION enforce_api_key_pool_access()
RETURNS trigger LANGUAGE plpgsql AS $api_key_pool_access$
DECLARE
  key_owner text;
BEGIN
  SELECT "userId" INTO key_owner FROM api_key WHERE id = NEW."apiKeyId";
  IF NOT EXISTS (SELECT 1 FROM pool WHERE id = NEW."poolId" AND "userId" = key_owner)
     AND NOT EXISTS (
       SELECT 1 FROM share WHERE "poolId" = NEW."poolId" AND "granteeUserId" = key_owner AND "canUse"
     ) THEN
    RAISE EXCEPTION 'an API key lists only pools its owner may use' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$api_key_pool_access$;
DROP TRIGGER IF EXISTS api_key_pool_access ON api_key_pool;
CREATE TRIGGER api_key_pool_access BEFORE INSERT OR UPDATE ON api_key_pool
FOR EACH ROW EXECUTE FUNCTION enforce_api_key_pool_access();

-- ═══════════════════════════════ providers ═══════════════════════════════

ALTER TABLE provider_account DROP CONSTRAINT IF EXISTS provider_account_shape_check;
ALTER TABLE provider_account ADD CONSTRAINT provider_account_shape_check CHECK (
  "providerType" IN ('openrouter', 'generic')
  AND btrim(label) <> ''
  AND btrim("baseUrl") <> ''
  AND btrim("endpointIdentity") <> ''
  AND "endpointVersion" > 0
  AND "nextFencingToken" >= 0
  AND "healthFencingWatermark" >= 0
  AND "nextFencingToken" >= "healthFencingWatermark"
  AND "healthFencingWatermark" >= COALESCE("healthHalfOpenFencingToken", 0)
  AND (enabled = FALSE OR "currentCredentialId" IS NOT NULL)
  AND (enabled = FALSE OR "deletedAt" IS NULL)
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

CREATE OR REPLACE FUNCTION enforce_provider_pricing_version_immutability()
RETURNS trigger LANGUAGE plpgsql AS $provider_pricing_immutable$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' AND current_setting('wsmp.user_deletion_writer', true) IS DISTINCT FROM 'on' THEN
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
    (OLD."activatedAt", OLD."retiredAt") IS DISTINCT FROM (NEW."activatedAt", NEW."retiredAt") THEN
    RAISE EXCEPTION 'provider pricing lifecycle timestamps are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$provider_pricing_immutable$;
DROP TRIGGER IF EXISTS provider_pricing_version_immutable ON provider_pricing_version;
CREATE TRIGGER provider_pricing_version_immutable BEFORE UPDATE OR DELETE ON provider_pricing_version
FOR EACH ROW EXECUTE FUNCTION enforce_provider_pricing_version_immutability();

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
       OR NEW."providerAccountId" IS DISTINCT FROM OLD."providerAccountId"
       OR NEW.type IS DISTINCT FROM OLD.type) THEN
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
BEFORE UPDATE OF id, "userId", "providerAccountId", type ON provider_model
FOR EACH ROW EXECUTE FUNCTION enforce_provider_graph_identity_immutable();

CREATE OR REPLACE FUNCTION enforce_provider_credential_account_consistency()
RETURNS trigger LANGUAGE plpgsql AS $provider_credential_account$
DECLARE account_owner TEXT; account_auth TEXT; current_id TEXT; replacement RECORD;
BEGIN
  SELECT "userId", "authType"::text, "currentCredentialId"
    INTO account_owner, account_auth, current_id
    FROM provider_account WHERE id = NEW."providerAccountId";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF account_owner IS DISTINCT FROM NEW."userId" OR account_auth IS DISTINCT FROM NEW."credentialType"::text THEN
    RAISE EXCEPTION 'provider credential must match its account owner and authentication type' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'ACTIVE' AND current_id IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'active provider credential must be current for its account' USING ERRCODE = '23514';
  END IF;
  IF NEW."replacedById" IS NOT NULL THEN
    SELECT "userId", "providerAccountId", "credentialType"::text AS "credentialType" INTO replacement
      FROM provider_credential WHERE id = NEW."replacedById";
    IF replacement."userId" IS DISTINCT FROM NEW."userId"
       OR replacement."providerAccountId" IS DISTINCT FROM NEW."providerAccountId"
       OR replacement."credentialType" IS DISTINCT FROM NEW."credentialType"::text THEN
      RAISE EXCEPTION 'provider credential replacement must stay within its account and authentication type' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
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
  IF NOT EXISTS (SELECT 1 FROM provider_account WHERE id = NEW.id) THEN
    RETURN NULL;
  END IF;
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
  RETURN NULL;
END;
$provider_current_credential$;
DROP TRIGGER IF EXISTS provider_account_current_credential_consistency ON provider_account;
CREATE CONSTRAINT TRIGGER provider_account_current_credential_consistency
AFTER INSERT OR UPDATE OF "currentCredentialId", "userId" ON provider_account
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_provider_current_credential_consistency();

-- Monthly caps: exactly one subject; the payer is the account owner / the share's pool owner.
ALTER TABLE spend_cap DROP CONSTRAINT IF EXISTS spend_cap_shape_check;
ALTER TABLE spend_cap ADD CONSTRAINT spend_cap_shape_check CHECK (
  "monthlyLimit" >= 0
  AND currency ~ '^[A-Z]{3}$'
  AND version >= 1
  AND ((scope = 'PROVIDER_ACCOUNT' AND "providerAccountId" IS NOT NULL AND "shareId" IS NULL)
    OR (scope = 'SHARE' AND "shareId" IS NOT NULL AND "providerAccountId" IS NULL))
);
CREATE OR REPLACE FUNCTION enforce_spend_cap_payer()
RETURNS trigger LANGUAGE plpgsql AS $spend_cap_payer$
BEGIN
  IF NEW.scope = 'PROVIDER_ACCOUNT' AND NOT EXISTS (
    SELECT 1 FROM provider_account WHERE id = NEW."providerAccountId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'an account cap is paid by the account owner' USING ERRCODE = '23514';
  END IF;
  IF NEW.scope = 'SHARE' AND NOT EXISTS (
    SELECT 1 FROM share WHERE id = NEW."shareId" AND "ownerUserId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'a share cap is paid by the pool owner' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."monthlyLimit" IS DISTINCT FROM OLD."monthlyLimit"
     AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'a cap change bumps its version' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$spend_cap_payer$;
DROP TRIGGER IF EXISTS spend_cap_scope_check ON spend_cap;
CREATE TRIGGER spend_cap_scope_check BEFORE INSERT OR UPDATE ON spend_cap
FOR EACH ROW EXECUTE FUNCTION enforce_spend_cap_payer();

-- Spend history (hot path, plain ids): shapes and append-only rules; the cross-row payer rule
-- (spend_graph_consistency) lands with the attempt pipeline (B3/B4).
ALTER TABLE spend_reservation DROP CONSTRAINT IF EXISTS spend_reservation_shape_check;
ALTER TABLE spend_reservation ADD CONSTRAINT spend_reservation_shape_check CHECK (
  "fencingToken" > 0 AND "capVersion" >= 1
  AND "reservedValue" >= 0 AND ("settledValue" IS NULL OR "settledValue" >= 0)
  AND currency ~ '^[A-Z]{3}$'
  AND "windowEnd" > "windowStart" AND "expiresAt" > "createdAt"
  AND ((state = 'RESERVED' AND "settledAt" IS NULL AND "settledValue" IS NULL)
    OR (state = 'SETTLED' AND "settledAt" IS NOT NULL AND "settledValue" IS NOT NULL))
);
CREATE OR REPLACE FUNCTION enforce_spend_reservation_transition()
RETURNS trigger LANGUAGE plpgsql AS $spend_reservation_transition$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('wsmp.user_deletion_writer', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'spend reservations cannot be deleted' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state', 'settledValue', 'settledAt']::text[])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'settledValue', 'settledAt']::text[])
     OR OLD.state <> 'RESERVED' OR NEW.state <> 'SETTLED' THEN
    RAISE EXCEPTION 'a reservation only settles, once' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$spend_reservation_transition$;
DROP TRIGGER IF EXISTS spend_reservation_transition ON spend_reservation;
CREATE TRIGGER spend_reservation_transition BEFORE UPDATE OR DELETE ON spend_reservation
FOR EACH ROW EXECUTE FUNCTION enforce_spend_reservation_transition();

ALTER TABLE spend_settlement DROP CONSTRAINT IF EXISTS spend_settlement_shape_check;
ALTER TABLE spend_settlement ADD CONSTRAINT spend_settlement_shape_check CHECK (
  "fencingToken" > 0 AND btrim(reason) <> '' AND btrim("sourceVersion") <> ''
  AND "revisionSequence" >= 0 AND btrim("payloadHash") <> ''
  AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);
DROP TRIGGER IF EXISTS spend_settlement_immutable ON spend_settlement;
CREATE TRIGGER spend_settlement_immutable BEFORE UPDATE ON spend_settlement
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();

ALTER TABLE usage_ledger DROP CONSTRAINT IF EXISTS usage_ledger_shape_check;
ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_shape_check CHECK (
  "fencingToken" > 0 AND ("settledCost" IS NULL OR "settledCost" >= 0)
  AND (currency IS NULL OR currency ~ '^[A-Z]{3}$')
  AND ("pricingVersion" IS NULL OR btrim("pricingVersion") <> '')
  AND btrim("accountingVersion") <> '' AND btrim("terminalReason") <> ''
  AND (NOT "costKnown" OR ("settledCost" IS NOT NULL AND currency IS NOT NULL AND "pricingVersion" IS NOT NULL))
  AND (NOT "costKnown" OR "observationComplete" IS TRUE)
  AND (NOT "usageKnown" OR "observationComplete" IS TRUE)
  AND ("reportedCost" IS NULL OR "reportedCost" >= 0)
  AND ("reportedCostCurrency" IS NULL OR "reportedCostCurrency" ~ '^[A-Z]{3}$')
  AND ("calculatedCost" IS NULL OR "calculatedCost" >= 0)
  AND ("calculatedCostCurrency" IS NULL OR "calculatedCostCurrency" ~ '^[A-Z]{3}$')
  AND ("inputTokens" IS NULL OR "inputTokens" >= 0)
  AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
  AND ("cacheReadTokens" IS NULL OR "cacheReadTokens" >= 0)
  AND ("cacheWriteTokens" IS NULL OR "cacheWriteTokens" >= 0)
  AND ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0)
  AND ("toolTokens" IS NULL OR "toolTokens" >= 0)
  AND ("billableTotal" IS NULL OR "billableTotal" >= 0)
  AND btrim("sourceVersion") <> '' AND btrim("usageSource") <> ''
  AND "revisionSequence" >= 0 AND btrim("payloadHash") <> ''
);
DROP TRIGGER IF EXISTS usage_ledger_immutable ON usage_ledger;
CREATE TRIGGER usage_ledger_immutable BEFORE UPDATE ON usage_ledger
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();

-- ═══════════════════════════════ telemetry ═══════════════════════════════

DROP TRIGGER IF EXISTS attempt_event_immutable ON attempt_event;
CREATE TRIGGER attempt_event_immutable BEFORE UPDATE ON attempt_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();

ALTER TABLE runtime_load_minute DROP CONSTRAINT IF EXISTS runtime_load_minute_shape_check;
ALTER TABLE runtime_load_minute ADD CONSTRAINT runtime_load_minute_shape_check CHECK (
  samples >= 0 AND "fullSamples" BETWEEN 0 AND samples
  AND "kvSamples" BETWEEN 0 AND samples
  AND "maxRunning" >= 0 AND ("maxWaiting" IS NULL OR "maxWaiting" >= 0)
  AND ("sumKvUsage" IS NULL OR "sumKvUsage" >= 0)
  AND ("maxKvUsage" IS NULL OR ("maxKvUsage" >= 0 AND "maxKvUsage" <= 1))
  AND ("maxKvOccupancy" IS NULL OR ("maxKvOccupancy" >= 0 AND "maxKvOccupancy" <= 1))
  AND ("maxSlotsBusy" IS NULL OR "maxSlotsBusy" >= 0)
  AND "prefixCacheHits" >= 0 AND "prefixCacheQueries" >= 0
  AND date_trunc('minute', "bucketStart") = "bucketStart"
);
ALTER TABLE node_metrics_minute DROP CONSTRAINT IF EXISTS node_metrics_minute_shape_check;
ALTER TABLE node_metrics_minute ADD CONSTRAINT node_metrics_minute_shape_check CHECK (
  samples >= 0 AND "cpuSamples" BETWEEN 0 AND samples AND "memorySamples" BETWEEN 0 AND samples
  AND date_trunc('minute', "bucketStart") = "bucketStart"
  AND jsonb_typeof(custom) = 'object'
  AND wsmp_jsonb_key_count(custom) <= 256
);

-- ═══════════════════════════════ misc ═══════════════════════════════

-- Configuration history: UPDATE refused, DELETE kept for the user-deletion drain.
DROP TRIGGER IF EXISTS audit_event_immutable ON audit_event;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE ON audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();
ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS audit_event_shape;
ALTER TABLE audit_event ADD CONSTRAINT audit_event_shape CHECK (
  (actor = 'AGENT') = ("agentTokenId" IS NOT NULL)
  AND action ~ '^[a-z_]+(\.[a-z_]+)*$'
  AND length("resourceType") BETWEEN 1 AND 64
  AND length("resourceId") BETWEEN 1 AND 128
);
ALTER TABLE media_asset DROP CONSTRAINT IF EXISTS media_asset_shape;
ALTER TABLE media_asset ADD CONSTRAINT media_asset_shape CHECK (
  "sizeBytes" >= 0 AND sha256 ~ '^[0-9a-f]{64}$' AND "expiresAt" > "createdAt"
);

-- ═══════════════════════════════ registry-backed checks ═══════════════════════════════

-- BEGIN GENERATED registry checks (scripts/registry-checks.mjs)
ALTER TABLE pool_advanced DROP CONSTRAINT IF EXISTS pool_advanced_overrides_check;
ALTER TABLE pool_advanced ADD CONSTRAINT pool_advanced_overrides_check CHECK (
  wsmp_registry_ok(overrides, '{"affinity":{"enabled":{"kind":"bool"},"ttlSeconds":{"kind":"int","min":60,"max":604800},"maxRecords":{"kind":"int","min":100,"max":100000},"prefixWeight":{"kind":"int","min":0,"max":10000},"conversationWeight":{"kind":"int","min":0,"max":10000},"confirmedCacheWeight":{"kind":"int","min":0,"max":10000},"loadPenaltyWeight":{"kind":"int","min":0,"max":10000},"residencyWeight":{"kind":"int","min":0,"max":10000}},"protection":{"enabled":{"kind":"bool"},"evictionFeedback":{"kind":"bool"},"windowSeconds":{"kind":"int","min":1,"max":3600},"minTokens":{"kind":"int","min":0,"max":10000000},"share":{"kind":"enum","values":["equal_share","first_come","fixed_percent"]},"fixedPercent":{"kind":"int","min":1,"max":100},"ownerPercent":{"kind":"int","min":0,"max":100}},"protocolAdaptation":{"kind":"bool"},"allowLossyDeveloperRoleCollapse":{"kind":"bool"},"recommendedSurface":{"kind":"enum","values":["openai_chat_completions","openai_responses","anthropic_messages"]},"maxAttachmentBytes":{"kind":"int","min":0,"max":536870912},"optimisticBasicTranscription":{"kind":"bool"}}'::jsonb)
  AND ("maxWaitMs" IS NULL OR "maxWaitMs" BETWEEN 0 AND 600000)
  AND ("contextCeiling" IS NULL OR "contextCeiling" BETWEEN 1 AND 100000000)
  AND ("contextMargin" IS NULL OR "contextMargin" BETWEEN 0 AND 1000000)
  AND ("contextCeiling" IS NULL OR "contextMargin" IS NULL OR "contextMargin" < "contextCeiling")
);
ALTER TABLE runtime_version DROP CONSTRAINT IF EXISTS runtime_version_advanced_check;
ALTER TABLE runtime_version ADD CONSTRAINT runtime_version_advanced_check CHECK (
  wsmp_registry_ok(advanced, '{"countStrategy":{"kind":"enum","values":["tokenizer","template_aware","engine_reported","conservative_estimate","calibrated_estimate"]},"imageTokenAllowance":{"kind":"int","min":0,"max":1000000},"maxAttachmentBytes":{"kind":"int","min":0,"max":536870912},"restartBudget":{"kind":"int","min":0,"max":100},"restartWindowMin":{"kind":"int","min":1,"max":1440},"unhealthyRestartMs":{"kind":"int","min":10000,"max":86400000},"unavailableStopMs":{"kind":"int","min":60000,"max":86400000}}'::jsonb)
);
ALTER TABLE runtime_version DROP CONSTRAINT IF EXISTS runtime_version_limits_check;
ALTER TABLE runtime_version ADD CONSTRAINT runtime_version_limits_check CHECK (
  ("concurrencyLimit" IS NULL OR "concurrencyLimit" BETWEEN 1 AND 10000)
  AND ("contextLimit" IS NULL OR "contextLimit" BETWEEN 1 AND 100000000)
  AND ("kvBudgetTokens" IS NULL OR "kvBudgetTokens" BETWEEN 1 AND 2147483647)
  AND ("kvFullThreshold" IS NULL OR "kvFullThreshold" BETWEEN 0.01 AND 1)
  AND ("engineLoadGate"::text IN ('AUTO', 'ENFORCE', 'OBSERVE'))
);
-- END GENERATED registry checks

-- ═══════════════════════════════ graph-write fences (DL-1, writer class M) ═══════════════════════════════

-- Every advisory lock the application takes is a transaction-scoped "fence" named LL:kind:id
-- (LL fixes the global order; packages/db/src/capacity-lock-order.ts is the only caller). A
-- fence is taken before the transaction's first row lock or write (WMPF1), in ascending order
-- (WMPF2); the held set is the transaction-local setting wsmp.fences. With wait = false a busy
-- fence returns false at once.
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
      RAISE EXCEPTION 'fence % requested after fence %', fence, last_fence USING ERRCODE = 'WMPF2';
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

-- A row key: `id`, or `poolId` for the 1:1 pool children.
CREATE OR REPLACE FUNCTION wsmp_row_key(row_data JSONB)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $wsmp_row_key$
  SELECT COALESCE(row_data ->> 'id', row_data ->> 'poolId')
$wsmp_row_key$;

-- Rows this transaction INSERTED (recorded AFTER INSERT): writing their policy needs no policy
-- fence, since no other transaction can see them.
CREATE OR REPLACE FUNCTION wsmp_row_created_here(relation TEXT, row_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $wsmp_created_here$
  SELECT strpos(COALESCE(current_setting('wsmp.created', true), ''),
                ',' || relation || ':' || row_id || ',') > 0
$wsmp_created_here$;
CREATE OR REPLACE FUNCTION wsmp_record_created_row()
RETURNS trigger LANGUAGE plpgsql AS $wsmp_record_created$
BEGIN
  PERFORM set_config('wsmp.created',
    COALESCE(current_setting('wsmp.created', true), '') || ',' || TG_TABLE_NAME || ':'
      || wsmp_row_key(to_jsonb(NEW)) || ',',
    true);
  RETURN NULL;
END;
$wsmp_record_created$;

-- The users whose owner fence a write of this graph row needs. A row linking two owners' graphs
-- (shares, API-key entries, contributed members) needs both. A parent that no longer exists
-- contributes nothing: the write is part of that parent's cascade, whose own trigger checked.
CREATE OR REPLACE FUNCTION wsmp_graph_row_owners(relation TEXT, row_data JSONB)
RETURNS TEXT[] LANGUAGE plpgsql STABLE AS $wsmp_graph_row_owners$
BEGIN
  RETURN CASE relation
    WHEN 'user' THEN ARRAY[row_data ->> 'id']
    WHEN 'runtime_version' THEN ARRAY[(SELECT "userId" FROM runtime WHERE id = row_data ->> 'runtimeId')]
    WHEN 'instance_rank' THEN ARRAY[(SELECT "userId" FROM runtime_instance WHERE id = row_data ->> 'instanceId')]
    WHEN 'instance_step' THEN ARRAY[(SELECT "userId" FROM runtime_instance WHERE id = row_data ->> 'instanceId')]
    WHEN 'profile_node' THEN ARRAY[(SELECT "userId" FROM profile WHERE id = row_data ->> 'profileId')]
    WHEN 'profile_item' THEN ARRAY[(SELECT "userId" FROM profile WHERE id = row_data ->> 'profileId')]
    WHEN 'pool_routing' THEN ARRAY[(SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_fallback' THEN ARRAY[(SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_advanced' THEN ARRAY[(SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_sidecar' THEN ARRAY[(SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_routing_rule' THEN ARRAY[(SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'pool_member' THEN ARRAY[
      (SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId'),
      (SELECT "userId" FROM runtime_model WHERE id = row_data ->> 'runtimeModelId')]
    WHEN 'api_key_pool' THEN ARRAY[
      (SELECT "userId" FROM api_key WHERE id = row_data ->> 'apiKeyId'),
      (SELECT "userId" FROM pool WHERE id = row_data ->> 'poolId')]
    WHEN 'share' THEN ARRAY[row_data ->> 'ownerUserId', row_data ->> 'granteeUserId']
    WHEN 'runtime_share' THEN ARRAY[row_data ->> 'ownerUserId', row_data ->> 'granteeUserId']
    ELSE ARRAY[row_data ->> 'userId']
  END;
END;
$wsmp_graph_row_owners$;

-- The execution targets whose admission view a pool's policy feeds: every target of every
-- member (a LOCAL member's served model on each instance; a CLOUD member's provider model).
CREATE OR REPLACE FUNCTION wsmp_member_target_ids(runtime_model_id TEXT, provider_model_id TEXT)
RETURNS SETOF TEXT LANGUAGE sql STABLE AS $wsmp_member_target_ids$
  SELECT id FROM execution_target
   WHERE (runtime_model_id IS NOT NULL AND "runtimeModelId" = runtime_model_id)
      OR (provider_model_id IS NOT NULL AND "providerModelId" = provider_model_id)
$wsmp_member_target_ids$;
CREATE OR REPLACE FUNCTION wsmp_pool_target_ids(pool_id TEXT)
RETURNS SETOF TEXT LANGUAGE sql STABLE AS $wsmp_pool_target_ids$
  SELECT DISTINCT t FROM pool_member m,
    LATERAL wsmp_member_target_ids(m."runtimeModelId", m."providerModelId") AS t
   WHERE m."poolId" = pool_id
$wsmp_pool_target_ids$;

-- Graph-write fence: an INSERT, a DELETE (cascades too) or an UPDATE of an identity/reference
-- column (TG_ARGV[0]) or policy column (TG_ARGV[1]) needs the owner fence of every owner; a
-- policy change also needs the fences of the admission views it changes (spec §2.14):
-- 06:capacity-policy:<target> (pool routing/advanced, share, member state/weight) and
-- 08:capacity:<instance> (runtime current version, instance admission version). Status columns
-- are not listed. A missing fence raises WMPF4.
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
  pool_id TEXT;
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
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND policy_changed
                            AND NOT wsmp_row_created_here(TG_TABLE_NAME, OLD.id)) THEN
      FOR target_id IN
        SELECT t FROM wsmp_member_target_ids(row_new ->> 'runtimeModelId', row_new ->> 'providerModelId') AS t
        UNION
        SELECT t FROM wsmp_member_target_ids(row_old ->> 'runtimeModelId', row_old ->> 'providerModelId') AS t
      LOOP
        CONTINUE WHEN wsmp_row_created_here('execution_target', target_id);
        PERFORM wsmp_require_fence('06:capacity-policy:' || target_id, TG_TABLE_NAME);
      END LOOP;
    END IF;
  ELSIF policy_changed AND NOT wsmp_row_created_here(TG_TABLE_NAME, wsmp_row_key(row_old)) THEN
    IF TG_TABLE_NAME IN ('pool_routing', 'pool_advanced', 'share') THEN
      pool_id := row_new ->> 'poolId';
      FOR target_id IN SELECT t FROM wsmp_pool_target_ids(pool_id) AS t LOOP
        PERFORM wsmp_require_fence('06:capacity-policy:' || target_id, TG_TABLE_NAME);
      END LOOP;
    ELSIF TG_TABLE_NAME = 'runtime_instance' THEN
      PERFORM wsmp_require_fence('08:capacity:' || NEW.id, TG_TABLE_NAME);
    ELSIF TG_TABLE_NAME = 'runtime' THEN
      FOR target_id IN SELECT id FROM runtime_instance WHERE "runtimeId" = NEW.id LOOP
        PERFORM wsmp_require_fence('08:capacity:' || target_id, TG_TABLE_NAME);
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
    ('node', 'id,userId,slug', ''),
    ('runtime', 'id,userId,slug,kind,nodeId', 'currentVersionId'),
    ('runtime_version', 'id,runtimeId,version', ''),
    ('runtime_model', 'id,userId,runtimeId,upstreamModelId,type', ''),
    ('runtime_share', 'id,runtimeId,ownerUserId,granteeUserId', ''),
    ('runtime_instance', 'id,userId,runtimeId,launchVersionId,handle,desiredState', 'versionId'),
    ('instance_rank', 'id,instanceId,nodeId,rank,claim', ''),
    ('instance_step', 'id,instanceId,nodeId,rank,phase,sequence,intent,intentHash,state', ''),
    ('runtime_operation', 'id,userId,profileId', ''),
    ('execution_target', 'id,userId,kind,instanceId,runtimeModelId,providerModelId', ''),
    ('profile', 'id,userId,slug', ''),
    ('profile_node', 'profileId,nodeId', ''),
    ('profile_item', 'id,profileId,position,runtimeId,versionId,count,nodeIds', ''),
    ('pool', 'id,userId,slug,modelType', ''),
    ('pool_routing', 'poolId', 'priorityClass,concurrencyLimit,keptSlots,borrowKept,ownHardwareOnly'),
    ('pool_fallback', 'poolId,mode,paidWarmProtection,ownKeyEquivalentModel', ''),
    ('pool_advanced', 'poolId', 'maxWaitMs,contextCeiling,contextMargin'),
    ('pool_sidecar', 'id,poolId,input,targetPoolId', ''),
    ('pool_member', 'id,poolId,kind,runtimeModelId,providerModelId,shareId,cloudOrder', 'state,weight'),
    ('pool_routing_rule', 'id,poolId,memberId,exclude,position,metric,labels,aggregate,op,threshold,effect', ''),
    ('api_key', 'id,userId,lookupPrefix,secretDigest,scope', ''),
    ('api_key_pool', 'apiKeyId,poolId', ''),
    ('share', 'id,poolId,ownerUserId,granteeUserId', 'priorityClass,canUse,canContribute'),
    ('provider_account', 'id,userId,currentCredentialId', ''),
    ('provider_model', 'id,userId,providerAccountId,upstreamModelId', ''),
    ('provider_credential', 'id,userId,providerAccountId,replacedById', ''),
    ('provider_pricing_version', 'id,userId,providerAccountId,providerModelId', ''),
    ('spend_cap', 'id,userId,scope,providerAccountId,shareId', '')
  ) AS t(relation, structural, policy)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS z_graph_write_fence ON %I', spec.relation);
    EXECUTE format('DROP TRIGGER IF EXISTS z_graph_update_fence ON %I', spec.relation);
    EXECUTE format('DROP TRIGGER IF EXISTS z_graph_created_row ON %I', spec.relation);
    IF spec.relation = 'user' THEN
      -- The user row: only its delete (the root of the user cascade) is fenced.
      EXECUTE format(
        'CREATE TRIGGER z_graph_write_fence BEFORE DELETE ON "user" '
        'FOR EACH ROW EXECUTE FUNCTION enforce_graph_write_fence(%L, %L)', '', '');
    ELSE
      IF spec.policy <> '' THEN
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

COMMIT;
