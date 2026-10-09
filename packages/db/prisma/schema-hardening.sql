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
LOCK TABLE "user", session, node, node_credential, node_enrollment_code, node_enrollment_use,
  fabric, fabric_member, node_command, node_audit_event,
  queued_node_command, runtime, runtime_version, runtime_model, runtime_share, runtime_instance,
  instance_rank, instance_step, runtime_operation, execution_target, profile, profile_node,
  profile_item, pool, pool_routing, pool_fallback, pool_advanced, pool_sidecar, pool_member,
  pool_routing_rule, api_key, api_key_pool, agent_token, share, share_invite, provider_account,
  provider_model,
  provider_credential, provider_pricing_version, spend_cap, spend_reservation, spend_settlement,
  usage_ledger, attempt_event, runtime_load_minute, node_metrics_minute, audit_event,
  media_asset, capacity_scheduler, admission_request, capacity_waiter, capacity_lease,
  capacity_kv_eviction, cache_affinity_record, cache_affinity_node, cache_affinity_scope,
  cache_affinity_observer, cache_affinity_residency, cache_affinity_residency_cursor,
  response_stickiness_record, relay_request IN ACCESS EXCLUSIVE MODE NOWAIT;

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
  slug ~ '^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$'
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
-- Fabrics (owner decision round 3): the frozen fabric memberships exist only at RELAY.
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_frozen_fabrics_shape;
ALTER TABLE node ADD CONSTRAINT node_frozen_fabrics_shape CHECK (
  ("frozenFabrics" IS NULL
   OR (trust = 'RELAY' AND jsonb_typeof("frozenFabrics") = 'array'
       AND jsonb_array_length("frozenFabrics") <= 32))
  AND ("fabricsHash" IS NULL OR "fabricsHash" ~ '^[0-9a-f]{64}$')
  AND ("heldFabricsHash" IS NULL OR "heldFabricsHash" ~ '^[0-9a-f]{64}$')
);
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_command_max_check;
ALTER TABLE node ADD CONSTRAINT node_command_max_check CHECK (
  "commandMaxMs" BETWEEN 60000 AND 86400000
);
-- Node commands: running ⇔ not finished; an exit code only after the command ended; the
-- identity and start never change, and a finished command stays finished.
ALTER TABLE node_command DROP CONSTRAINT IF EXISTS node_command_shape;
ALTER TABLE node_command ADD CONSTRAINT node_command_shape CHECK (
  id ~ '^[A-Za-z0-9_-]{22}$'
  AND length(subject) BETWEEN 1 AND 4096
  -- An agent acted through exactly one credential: an agent token or an OAuth grant.
  AND (actor = 'AGENT') = (num_nonnulls("agentTokenId", "mcpGrantId") = 1)
  AND num_nonnulls("agentTokenId", "mcpGrantId") <= 1
  AND "endsBy" > "startedAt" AND "endsBy" <= "startedAt" + interval '24 hours'
  AND (state = 'RUNNING') = ("finishedAt" IS NULL)
  AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
  AND ("exitCode" IS NULL OR ("exitCode" BETWEEN 0 AND 255 AND state IN ('SUCCEEDED', 'FAILED')))
  AND (signal IS NULL OR signal ~ '^[A-Za-z0-9_+.-]{1,32}$')
);
CREATE OR REPLACE FUNCTION enforce_node_command_transition()
RETURNS trigger LANGUAGE plpgsql AS $node_command_transition$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'exitCode', 'signal', 'finishedAt', 'updatedAt']::text[])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'exitCode', 'signal', 'finishedAt', 'updatedAt']::text[]) THEN
    RAISE EXCEPTION 'a node command keeps its identity' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'RUNNING' AND (NEW.state, NEW."exitCode", NEW.signal, NEW."finishedAt")
      IS DISTINCT FROM (OLD.state, OLD."exitCode", OLD.signal, OLD."finishedAt") THEN
    RAISE EXCEPTION 'a finished node command stays finished' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$node_command_transition$;
DROP TRIGGER IF EXISTS node_command_transition ON node_command;
CREATE TRIGGER node_command_transition BEFORE UPDATE ON node_command
FOR EACH ROW EXECUTE FUNCTION enforce_node_command_transition();

-- Node hold: a note or a profile only on a held node.
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_hold_shape;
ALTER TABLE node ADD CONSTRAINT node_hold_shape CHECK (
  ("holdAt" IS NOT NULL OR ("holdNote" IS NULL AND "holdProfileId" IS NULL))
  AND ("holdNote" IS NULL OR length("holdNote") BETWEEN 1 AND 500)
);
-- A profile hold names a profile of the node's owner.
CREATE OR REPLACE FUNCTION enforce_node_hold_profile_owner()
RETURNS trigger LANGUAGE plpgsql AS $node_hold_profile_owner$
BEGIN
  IF NEW."holdProfileId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profile p WHERE p.id = NEW."holdProfileId" AND p."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'a node hold names a profile of the node''s owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$node_hold_profile_owner$;
DROP TRIGGER IF EXISTS node_hold_profile_owner ON node;
CREATE TRIGGER node_hold_profile_owner BEFORE INSERT OR UPDATE OF "holdProfileId", "userId" ON node
FOR EACH ROW EXECUTE FUNCTION enforce_node_hold_profile_owner();
-- A node keeps its owner: everything that reaches a node (its credentials, commands, runtimes,
-- instance ranks and steps) is checked against the owner it had when it was written.
CREATE OR REPLACE FUNCTION enforce_node_owner_immutable()
RETURNS trigger LANGUAGE plpgsql AS $node_owner_immutable$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'a node keeps its owner' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$node_owner_immutable$;
DROP TRIGGER IF EXISTS node_owner_immutable ON node;
CREATE TRIGGER node_owner_immutable BEFORE UPDATE OF "userId" ON node
FOR EACH ROW EXECUTE FUNCTION enforce_node_owner_immutable();
-- Temporary nodes: removed after 1 min .. 30 days offline (the sweeper deletes them like a
-- manual delete).
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_temporary_shape;
ALTER TABLE node ADD CONSTRAINT node_temporary_shape CHECK (
  "removeAfterOfflineMs" IS NULL OR "removeAfterOfflineMs" BETWEEN 60000 AND 2592000000::bigint
);

-- A node's address on a fabric (packages/api/src/lib/ip-literal.ts `isFabricIp`, Rust
-- `is_fabric_ip`; shared vectors in apps/cli/tests/fixtures/relay-3.0/rules/fabric-ip.json):
-- the canonical text of one address (PostgreSQL's host() form: dotted quad without leading
-- zeros, RFC 5952 IPv6), no prefix, zone or brackets, no embedded IPv4 in IPv6, and never
-- 0.0.0.0/8, loopback, ::/96 (unspecified, ::1, IPv4-compatible) or IPv4-mapped.
CREATE OR REPLACE FUNCTION wsmp_is_fabric_ip(value TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $wsmp_is_fabric_ip$
DECLARE
  parsed inet;
BEGIN
  IF value IS NULL OR length(value) > 39 OR value !~ '^[0-9a-f.:]+$' THEN
    RETURN false;
  END IF;
  parsed := value::inet;
  -- (No CASE in an IF condition: PL/pgSQL ends the condition at the first THEN.)
  IF host(parsed) <> value OR masklen(parsed) <> (32 + 96 * (family(parsed) / 6)) THEN
    RETURN false;
  END IF;
  IF family(parsed) = 4 THEN
    RETURN NOT parsed <<= '0.0.0.0/8'::inet AND NOT parsed <<= '127.0.0.0/8'::inet;
  END IF;
  RETURN position('.' in value) = 0
    AND NOT parsed <<= '::/96'::inet AND NOT parsed <<= '::ffff:0:0/96'::inet;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN false;
END;
$wsmp_is_fabric_ip$;

ALTER TABLE fabric DROP CONSTRAINT IF EXISTS fabric_shape;
ALTER TABLE fabric ADD CONSTRAINT fabric_shape CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$');
ALTER TABLE fabric_member DROP CONSTRAINT IF EXISTS fabric_member_shape;
ALTER TABLE fabric_member ADD CONSTRAINT fabric_member_shape CHECK (wsmp_is_fabric_ip(ip));
-- A member that a live multi-node instance on its fabric uses (a rank on this node that is not
-- released) keeps its IP and membership: the node derives its interface from that IP, so a
-- change under it would split the instance (`fabric_member_in_use`). Deleting the node itself
-- first releases its ranks (node_delete_release), so it is never blocked by this.
CREATE OR REPLACE FUNCTION enforce_fabric_member_in_use()
RETURNS trigger LANGUAGE plpgsql AS $fabric_member_in_use$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.ip IS NOT DISTINCT FROM OLD.ip THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM runtime_instance i JOIN instance_rank k ON k."instanceId" = i.id
     WHERE i."fabricId" = OLD."fabricId" AND k."nodeId" = OLD."nodeId" AND k.claim <> 'RELEASED'
  ) THEN
    RAISE EXCEPTION 'fabric_member_in_use: a running multi-node instance uses this address'
      USING ERRCODE = 'WMPP1';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$fabric_member_in_use$;
DROP TRIGGER IF EXISTS fabric_member_in_use ON fabric_member;
CREATE TRIGGER fabric_member_in_use BEFORE UPDATE OF ip OR DELETE ON fabric_member
FOR EACH ROW EXECUTE FUNCTION enforce_fabric_member_in_use();
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

-- Multi-use codes (owner decision round 3): 1..50 uses, at most 7 days, labels like node
-- labels; a replace code is single-use and carries no labels.
ALTER TABLE node_enrollment_code DROP CONSTRAINT IF EXISTS node_enrollment_code_shape;
ALTER TABLE node_enrollment_code ADD CONSTRAINT node_enrollment_code_shape CHECK (
  "expiresAt" <= "createdAt" + interval '7 days'
  AND "expiresAt" > "createdAt"
  AND length("codePrefix") = 8
  AND "codeDigest" ~ '^[0-9a-f]{64}$'
  AND "maxUses" BETWEEN 1 AND 50
  AND "usedCount" BETWEEN 0 AND "maxUses"
  AND ("usedCount" = 0) = ("lastUsedAt" IS NULL)
  AND cardinality(labels) <= 32
  AND ("replaceNodeId" IS NULL OR ("maxUses" = 1 AND cardinality(labels) = 0))
  AND ("suggestedSlug" IS NULL OR "maxUses" = 1)
  AND ("removeAfterOfflineMs" IS NULL OR "removeAfterOfflineMs" BETWEEN 60000 AND 2592000000::bigint)
  AND ("replaceNodeId" IS NULL OR "removeAfterOfflineMs" IS NULL)
);
-- A code is created unused, takes one use per exchange (never while revoked or expired), and
-- only ever binds or replaces nodes of its owner. Everything but the use counter and the
-- revocation is immutable.
CREATE OR REPLACE FUNCTION enforce_node_enrollment_code_use()
RETURNS trigger LANGUAGE plpgsql AS $node_enrollment_code_use$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."usedCount" <> 0 OR NEW."revokedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'an enrollment code is created unused' USING ERRCODE = '23514';
    END IF;
    IF NEW."replaceNodeId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW."replaceNodeId" AND "userId" = NEW."userId") THEN
      RAISE EXCEPTION 'a replace code names a node of its owner' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['usedCount', 'lastUsedAt', 'revokedAt', 'replaceNodeId']::text[])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['usedCount', 'lastUsedAt', 'revokedAt', 'replaceNodeId']::text[])
     -- deleting the replaced node nulls replaceNodeId (ON DELETE CASCADE removes the code)
     OR (NEW."replaceNodeId" IS NOT NULL AND NEW."replaceNodeId" IS DISTINCT FROM OLD."replaceNodeId") THEN
    RAISE EXCEPTION 'an enrollment code is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'a revoked enrollment code stays revoked' USING ERRCODE = '55000';
  END IF;
  IF NEW."usedCount" <> OLD."usedCount" THEN
    IF NEW."usedCount" <> OLD."usedCount" + 1 THEN
      RAISE EXCEPTION 'an enrollment code is used one exchange at a time' USING ERRCODE = '55000';
    END IF;
    IF OLD."revokedAt" IS NOT NULL OR OLD."expiresAt" <= now() THEN
      RAISE EXCEPTION 'a revoked or expired enrollment code is not used' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$node_enrollment_code_use$;
DROP TRIGGER IF EXISTS node_enrollment_code_use ON node_enrollment_code;
CREATE TRIGGER node_enrollment_code_use BEFORE INSERT OR UPDATE ON node_enrollment_code
FOR EACH ROW EXECUTE FUNCTION enforce_node_enrollment_code_use();

-- A use names a code and a node of the same owner; uses are append-only (the node FK may
-- still null nodeId when the node is deleted).
CREATE OR REPLACE FUNCTION enforce_node_enrollment_use_shape()
RETURNS trigger LANGUAGE plpgsql AS $node_enrollment_use_shape$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."nodeId" IS NULL AND (to_jsonb(NEW) - 'nodeId') = (to_jsonb(OLD) - 'nodeId') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'node_enrollment_use is append-only' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM node_enrollment_code WHERE id = NEW."codeId" AND "userId" = NEW."userId")
     OR (NEW."nodeId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM node WHERE id = NEW."nodeId" AND "userId" = NEW."userId")) THEN
    RAISE EXCEPTION 'an enrollment use names a code and a node of one owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$node_enrollment_use_shape$;
DROP TRIGGER IF EXISTS node_enrollment_use_shape ON node_enrollment_use;
CREATE TRIGGER node_enrollment_use_shape BEFORE INSERT OR UPDATE ON node_enrollment_use
FOR EACH ROW EXECUTE FUNCTION enforce_node_enrollment_use_shape();

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
  AND (actor = 'AGENT') = (num_nonnulls("agentTokenId", "mcpGrantId") = 1)
  AND num_nonnulls("agentTokenId", "mcpGrantId") <= 1
  AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")
);
DROP TRIGGER IF EXISTS node_audit_event_append_only ON node_audit_event;
CREATE TRIGGER node_audit_event_append_only BEFORE UPDATE ON node_audit_event
FOR EACH ROW EXECUTE FUNCTION reject_immutable_history_mutation();

ALTER TABLE queued_node_command DROP CONSTRAINT IF EXISTS queued_node_command_shape;
ALTER TABLE queued_node_command ADD CONSTRAINT queued_node_command_shape CHECK (
  octet_length(command) BETWEEN 1 AND 16384
  -- Queued by an agent: through exactly one credential (agent token or OAuth grant).
  AND num_nonnulls("agentTokenId", "mcpGrantId") = 1
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
  IF (NEW.command, NEW.note, NEW."nodeId", NEW."userId", NEW."agentTokenId", NEW."mcpGrantId",
      NEW."expiresAt")
     IS DISTINCT FROM (OLD.command, OLD.note, OLD."nodeId", OLD."userId", OLD."agentTokenId",
      OLD."mcpGrantId", OLD."expiresAt") THEN
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
  AND api::text IS NOT DISTINCT FROM upper(spec ->> 'api')
  AND engine::text IS NOT DISTINCT FROM upper(spec ->> 'engine')
  AND "modelType"::text IS NOT DISTINCT FROM upper(spec ->> 'modelType')
  -- a service (no api/engine/modelType/models) is startable; a served runtime has all three
  AND ((api IS NULL) = (engine IS NULL) AND (api IS NULL) = ("modelType" IS NULL))
  AND (api IS NOT NULL OR (spec ? 'launch' AND NOT spec ? 'models'))
  AND (spec ? 'launch') <> (spec ? 'address')
  AND "launchHash" ~ '^[0-9a-f]{64}$'
  AND "contentHash" ~ '^[0-9a-f]{64}$'
  AND version >= 1
  AND (editor = 'AGENT') = (num_nonnulls("agentTokenId", "mcpGrantId") = 1)
  AND num_nonnulls("agentTokenId", "mcpGrantId") <= 1
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
  AND ("healthDetail" IS NULL OR "healthDetail" ~ '^[a-z0-9_]{1,64}$')
  -- A multi-node instance names its fabric until it is down (then the fabric may go).
  AND ("fabricId" IS NULL OR ("desiredState" IS NOT NULL AND phase NOT IN ('STOPPED', 'FAILED')))
);
ALTER TABLE runtime_instance DROP CONSTRAINT IF EXISTS runtime_instance_notify_failures;
ALTER TABLE runtime_instance ADD CONSTRAINT runtime_instance_notify_failures
  CHECK ("needsOperatorNotifyFailures" BETWEEN 0 AND 1000);
-- needsOperator and its timestamp travel together; RESTART only for an instance that should
-- run and has stopped; MARK_STOPPED only while STOPPING.
ALTER TABLE runtime_instance DROP CONSTRAINT IF EXISTS runtime_instance_operator_shape;
ALTER TABLE runtime_instance ADD CONSTRAINT runtime_instance_operator_shape CHECK (
  ("needsOperator" IS NULL) = ("needsOperatorSince" IS NULL)
  AND ("needsOperator" IS DISTINCT FROM 'RESTART'
       OR ("desiredState" = 'RUNNING' AND phase IN ('STOPPED', 'FAILED')))
  AND ("needsOperator" IS DISTINCT FROM 'MARK_STOPPED' OR phase = 'STOPPING')
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
-- The operation that last changed an instance (a start, a stop, a preemption, a profile apply)
-- is its owner's: no operation of one user can start or stop another user's instance.
CREATE OR REPLACE FUNCTION enforce_runtime_instance_operation_owner()
RETURNS trigger LANGUAGE plpgsql AS $runtime_instance_operation_owner$
BEGIN
  IF NEW."operationId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."operationId" IS DISTINCT FROM OLD."operationId")
     AND NOT EXISTS (
       SELECT 1 FROM runtime_operation o WHERE o.id = NEW."operationId" AND o."userId" = NEW."userId"
     ) THEN
    RAISE EXCEPTION 'an instance is changed only by an operation of its owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$runtime_instance_operation_owner$;
DROP TRIGGER IF EXISTS runtime_instance_operation_owner ON runtime_instance;
CREATE TRIGGER runtime_instance_operation_owner
BEFORE INSERT OR UPDATE OF "operationId", "userId" ON runtime_instance
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_instance_operation_owner();

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
  (claim <> 'HELD_UNKNOWN' OR "markedStoppedAt" IS NOT NULL)
  AND (claim <> 'RELEASED' OR "stoppedAt" IS NOT NULL)
  AND ("markedStoppedAt" IS NULL) = ("markedStoppedBy" IS NULL)
);
-- The held-unknown probe sweep takes these rows least recently checked first.
DROP INDEX IF EXISTS instance_rank_held_unknown_id;
CREATE INDEX IF NOT EXISTS instance_rank_held_unknown_check
  ON instance_rank ("lastStopCheckAt" ASC NULLS FIRST, id) WHERE claim = 'HELD_UNKNOWN';
-- A rank claims, and a step runs on, a node of the instance's owner only: the relay sends a
-- step's job to its node, so this keeps one user's commands off another user's nodes. A step's
-- node is checked when it is written (no foreign key: a deleted node leaves its steps).
CREATE OR REPLACE FUNCTION enforce_instance_node_owner()
RETURNS trigger LANGUAGE plpgsql AS $instance_node_owner$
BEGIN
  IF NEW."nodeId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId"
          OR NEW."instanceId" IS DISTINCT FROM OLD."instanceId")
     AND NOT EXISTS (
       -- KEY SHARE on the node: a write racing the node's delete waits for it, then sees the
       -- node gone (a step has no foreign key that would make it wait). A writer that already
       -- holds the instance can deadlock with node_delete_release (which updates the instance
       -- after locking the node), as rank inserts could through their foreign key before: one
       -- side gets 40P01, which the graph-write and lifecycle retries treat as retryable.
       SELECT 1 FROM runtime_instance i JOIN node n ON n."userId" = i."userId"
        WHERE i.id = NEW."instanceId" AND n.id = NEW."nodeId"
        FOR KEY SHARE OF n
     ) THEN
    RAISE EXCEPTION 'an instance runs only on nodes of its owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$instance_node_owner$;
DROP TRIGGER IF EXISTS instance_rank_node_owner ON instance_rank;
CREATE TRIGGER instance_rank_node_owner BEFORE INSERT OR UPDATE OF "nodeId", "instanceId" ON instance_rank
FOR EACH ROW EXECUTE FUNCTION enforce_instance_node_owner();
DROP TRIGGER IF EXISTS instance_step_node_owner ON instance_step;
CREATE TRIGGER instance_step_node_owner BEFORE INSERT OR UPDATE OF "nodeId", "instanceId" ON instance_step
FOR EACH ROW EXECUTE FUNCTION enforce_instance_node_owner();

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
  (actor = 'AGENT') = (num_nonnulls("agentTokenId", "mcpGrantId") = 1)
  AND num_nonnulls("agentTokenId", "mcpGrantId") <= 1
  -- Only a profile apply names a profile; deleting the profile nulls it (history stays).
  AND (kind = 'PROFILE_APPLY' OR "profileId" IS NULL)
  AND fingerprint ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(summary) = 'object'
);
-- A profile apply is recorded with its profile (only the profile's delete clears it later).
CREATE OR REPLACE FUNCTION enforce_runtime_operation_profile()
RETURNS trigger LANGUAGE plpgsql AS $runtime_operation_profile$
BEGIN
  IF NEW.kind = 'PROFILE_APPLY' AND NEW."profileId" IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.kind IS DISTINCT FROM NEW.kind
          -- The profile's own delete (FK SET NULL) runs after its row is gone.
          OR EXISTS (SELECT 1 FROM profile WHERE id = OLD."profileId")) THEN
    RAISE EXCEPTION 'a profile apply names its profile' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$runtime_operation_profile$;
DROP TRIGGER IF EXISTS runtime_operation_profile ON runtime_operation;
CREATE TRIGGER runtime_operation_profile BEFORE INSERT OR UPDATE OF kind, "profileId" ON runtime_operation
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_operation_profile();
-- An operation keeps its owner: the owner check on the instances it marks
-- (runtime_instance_operation_owner) holds for the operation's lifetime.
CREATE OR REPLACE FUNCTION enforce_runtime_operation_owner_immutable()
RETURNS trigger LANGUAGE plpgsql AS $runtime_operation_owner_immutable$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" THEN
    RAISE EXCEPTION 'an operation keeps its owner' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$runtime_operation_owner_immutable$;
DROP TRIGGER IF EXISTS runtime_operation_owner_immutable ON runtime_operation;
CREATE TRIGGER runtime_operation_owner_immutable BEFORE UPDATE OF "userId" ON runtime_operation
FOR EACH ROW EXECUTE FUNCTION enforce_runtime_operation_owner_immutable();

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

ALTER TABLE profile_node DROP CONSTRAINT IF EXISTS profile_node_hold_shape;
ALTER TABLE profile_node ADD CONSTRAINT profile_node_hold_shape CHECK (
  (hold OR "holdNote" IS NULL) AND ("holdNote" IS NULL OR length("holdNote") BETWEEN 1 AND 500)
);

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

-- Share invites (owner decision round 3): an e-mail whose mailbox is not proved. The target is
-- a pool or (since the proved-mailbox rule) a runtime definition, never both. The invite keeps
-- the share's settings; acceptance (the link, or a proved e-mail) creates the share and records
-- it.
-- A claim written before claims named their e-mail (fe5c26f7) is dropped, so the shape check
-- below applies. The transition trigger (recreated below) would refuse it on a final invite.
DROP TRIGGER IF EXISTS share_invite_transition ON share_invite;
UPDATE share_invite SET "signupClaimedAt" = NULL, "signupClaimedEmail" = NULL
 WHERE ("signupClaimedAt" IS NULL) <> ("signupClaimedEmail" IS NULL);
ALTER TABLE share_invite DROP CONSTRAINT IF EXISTS share_invite_shape;
ALTER TABLE share_invite ADD CONSTRAINT share_invite_shape CHECK (
  email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 320 AND position('@' in email) > 1
  AND "tokenDigest" ~ '^[0-9a-f]{64}$'
  AND ("canUse" OR "canContribute")
  AND "expiresAt" > "createdAt"
  AND NOT ("acceptedAt" IS NOT NULL AND "revokedAt" IS NOT NULL)
  AND ("shareId" IS NULL OR "acceptedAt" IS NOT NULL)
  -- An invite-link sign-up claim names its time and its (normalized) e-mail together.
  AND (("signupClaimedAt" IS NULL) = ("signupClaimedEmail" IS NULL))
  AND ("signupClaimedEmail" IS NULL OR "signupClaimedEmail" = lower(btrim("signupClaimedEmail")))
);
-- Exactly one target. A runtime share carries no settings: a runtime invite is "can use" only,
-- and records a runtime share (never a pool share); a pool invite never records a runtime share.
ALTER TABLE share_invite DROP CONSTRAINT IF EXISTS share_invite_target_shape;
ALTER TABLE share_invite ADD CONSTRAINT share_invite_target_shape CHECK (
  (("poolId" IS NULL) <> ("runtimeId" IS NULL))
  AND ("runtimeShareId" IS NULL OR "acceptedAt" IS NOT NULL)
  AND ("poolId" IS NULL OR "runtimeShareId" IS NULL)
  AND ("runtimeId" IS NULL
       OR ("shareId" IS NULL AND "canUse" AND NOT "canContribute" AND "priorityClass" IS NULL))
);
CREATE OR REPLACE FUNCTION enforce_share_invite_transition()
RETURNS trigger LANGUAGE plpgsql AS $share_invite_transition$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['updatedAt', 'emailSentAt', 'acceptedAt', 'shareId',
                             'runtimeShareId', 'revokedAt', 'canUse', 'canContribute',
                             'priorityClass', 'tokenDigest', 'expiresAt', 'signupClaimedAt',
                             'signupClaimedEmail']::text[])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updatedAt', 'emailSentAt', 'acceptedAt', 'shareId',
                             'runtimeShareId', 'revokedAt', 'canUse', 'canContribute',
                             'priorityClass', 'tokenDigest', 'expiresAt', 'signupClaimedAt',
                             'signupClaimedEmail']::text[]) THEN
    RAISE EXCEPTION 'a share invite keeps its target and e-mail' USING ERRCODE = '55000';
  END IF;
  -- Resend rotates the token and the expiry, only while the invite is pending, and the expiry
  -- only moves together with a new token (an old link never gets more time).
  IF (OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL)
     AND (NEW."tokenDigest" IS DISTINCT FROM OLD."tokenDigest"
          OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt") THEN
    RAISE EXCEPTION 'an accepted or revoked share invite is final' USING ERRCODE = '55000';
  END IF;
  IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     AND NEW."tokenDigest" IS NOT DISTINCT FROM OLD."tokenDigest" THEN
    RAISE EXCEPTION 'a share invite gets a new expiry only with a new link' USING ERRCODE = '55000';
  END IF;
  IF (OLD."acceptedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL)
     AND (NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
          OR NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
          OR NEW."canUse" IS DISTINCT FROM OLD."canUse"
          OR NEW."canContribute" IS DISTINCT FROM OLD."canContribute"
          OR NEW."priorityClass" IS DISTINCT FROM OLD."priorityClass"
          OR NEW."signupClaimedAt" IS DISTINCT FROM OLD."signupClaimedAt"
          OR NEW."signupClaimedEmail" IS DISTINCT FROM OLD."signupClaimedEmail"
          OR (NEW."shareId" IS NOT NULL AND NEW."shareId" IS DISTINCT FROM OLD."shareId")
          OR (NEW."runtimeShareId" IS NOT NULL
              AND NEW."runtimeShareId" IS DISTINCT FROM OLD."runtimeShareId")) THEN
    RAISE EXCEPTION 'an accepted or revoked share invite is final' USING ERRCODE = '55000';
  END IF;
  -- The accepted share is a share of the invite's pool or runtime, whatever the grantee e-mail:
  -- an invite link is the proof, so the person who signed up through it may use another address
  -- (packages/api lib/invite-acceptance.ts decides when an e-mail match is enough).
  IF NEW."acceptedAt" IS NOT NULL AND OLD."acceptedAt" IS NULL
     AND NEW."poolId" IS NOT NULL
     AND (NEW."shareId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM share s
                          WHERE s.id = NEW."shareId" AND s."poolId" = NEW."poolId")) THEN
    RAISE EXCEPTION 'an accepted invite names a share of its pool' USING ERRCODE = '23514';
  END IF;
  IF NEW."acceptedAt" IS NOT NULL AND OLD."acceptedAt" IS NULL
     AND NEW."runtimeId" IS NOT NULL
     AND (NEW."runtimeShareId" IS NULL
          OR NOT EXISTS (SELECT 1 FROM runtime_share s
                          WHERE s.id = NEW."runtimeShareId"
                            AND s."runtimeId" = NEW."runtimeId")) THEN
    RAISE EXCEPTION 'an accepted invite names a share of its runtime' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$share_invite_transition$;
DROP TRIGGER IF EXISTS share_invite_transition ON share_invite;
CREATE TRIGGER share_invite_transition BEFORE UPDATE ON share_invite
FOR EACH ROW EXECUTE FUNCTION enforce_share_invite_transition();
-- A new invite starts pending: it is accepted (with the share it made) or revoked only by a
-- later UPDATE, which the transition trigger checks. The deploy marker does not exempt it.
CREATE OR REPLACE FUNCTION enforce_share_invite_starts_pending()
RETURNS trigger LANGUAGE plpgsql AS $share_invite_starts_pending$
BEGIN
  IF NEW."acceptedAt" IS NOT NULL OR NEW."revokedAt" IS NOT NULL
     OR NEW."shareId" IS NOT NULL OR NEW."runtimeShareId" IS NOT NULL THEN
    RAISE EXCEPTION 'a new share invite starts pending' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$share_invite_starts_pending$;
DROP TRIGGER IF EXISTS share_invite_starts_pending ON share_invite;
CREATE TRIGGER share_invite_starts_pending BEFORE INSERT ON share_invite
FOR EACH ROW EXECUTE FUNCTION enforce_share_invite_starts_pending();
-- A link is valid at most 30 days from when it was issued (created or resent).
CREATE OR REPLACE FUNCTION enforce_share_invite_expiry()
RETURNS trigger LANGUAGE plpgsql AS $share_invite_expiry$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt")
     AND NEW."expiresAt" > now() + interval '30 days' THEN
    RAISE EXCEPTION 'a share invite link lasts at most 30 days' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$share_invite_expiry$;
DROP TRIGGER IF EXISTS share_invite_expiry ON share_invite;
CREATE TRIGGER share_invite_expiry BEFORE INSERT OR UPDATE OF "expiresAt" ON share_invite
FOR EACH ROW EXECUTE FUNCTION enforce_share_invite_expiry();
-- One pending invite per target and e-mail; accepted and revoked ones are history. A runtime
-- invite's null poolId never collides in the pool index (nulls are distinct), and the runtime
-- index covers runtime invites only.
CREATE UNIQUE INDEX IF NOT EXISTS share_invite_one_pending
  ON share_invite ("poolId", email) WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS share_invite_one_pending_runtime
  ON share_invite ("runtimeId", email)
  WHERE "runtimeId" IS NOT NULL AND "acceptedAt" IS NULL AND "revokedAt" IS NULL;

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
  acct RECORD;
BEGIN
  -- Deferred to commit, where NEW is the row as of its event: check the row as it is now (an
  -- account is inserted, then given its first credential, in one transaction).
  SELECT id, "userId", "currentCredentialId", "authType"::text AS "authType" INTO acct
    FROM provider_account WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF acct."currentCredentialId" IS NOT NULL THEN
    SELECT "userId", "providerAccountId", status::text, "credentialType"::text
      INTO credential_owner, credential_account, credential_state, credential_auth
      FROM provider_credential WHERE id = acct."currentCredentialId";
    IF credential_owner IS DISTINCT FROM acct."userId" OR credential_account IS DISTINCT FROM acct.id
       OR credential_state IS DISTINCT FROM 'ACTIVE' OR credential_auth IS DISTINCT FROM acct."authType" THEN
      RAISE EXCEPTION 'current provider credential must be active and belong to the account owner' USING ERRCODE = '23514';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM provider_credential
     WHERE "providerAccountId" = acct.id AND "userId" = acct."userId" AND status = 'ACTIVE'
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
  (actor = 'AGENT') = (num_nonnulls("agentTokenId", "mcpGrantId") = 1)
  AND num_nonnulls("agentTokenId", "mcpGrantId") <= 1
  AND action ~ '^[a-z_]+(\.[a-z_]+)*$'
  AND length("resourceType") BETWEEN 1 AND 64
  AND length("resourceId") BETWEEN 1 AND 128
);
ALTER TABLE media_asset DROP CONSTRAINT IF EXISTS media_asset_shape;
ALTER TABLE media_asset ADD CONSTRAINT media_asset_shape CHECK (
  "sizeBytes" >= 0 AND sha256 ~ '^[0-9a-f]{64}$' AND "expiresAt" > "createdAt"
);

-- ═══════════════════════════════ hot path (writer class H, S0d) ═══════════════════════════════
-- No foreign keys to or from the graph (DL-1): these checks are the integrity boundary. They
-- are plain SELECTs (no row lock) and tolerate a deleted parent: a row that names a pool,
-- member, target or instance deleted concurrently is an orphan the sweepers terminalize.
-- capacityId = runtime_instance.id; executionTargetId = execution_target.id.

-- Hot-path rows store a priority class as its rank (scheduler order, limits redesign).
CREATE OR REPLACE FUNCTION wsmp_priority_class_rank(priority_class "PriorityClass")
RETURNS integer LANGUAGE sql IMMUTABLE AS $wsmp_priority_class_rank$
  SELECT CASE priority_class WHEN 'BACKGROUND' THEN 0 WHEN 'NORMAL' THEN 1 WHEN 'HIGH' THEN 2 END
$wsmp_priority_class_rank$;

-- Scheduler v2: three classes, HIGH first (DRR quanta 1 / 4 / 16).
ALTER TABLE capacity_scheduler DROP CONSTRAINT IF EXISTS capacity_scheduler_check;
ALTER TABLE capacity_scheduler ADD CONSTRAINT capacity_scheduler_check CHECK (
  "schedulerCursor" BETWEEN 0 AND 2
  AND "schedulerVersion" = 2
  AND "nextFencingToken" > 0
  AND jsonb_typeof("schedulerDeficits") = 'array'
  AND jsonb_array_length("schedulerDeficits") = 3
);

ALTER TABLE admission_request DROP CONSTRAINT IF EXISTS admission_request_shape_check;
ALTER TABLE admission_request ADD CONSTRAINT admission_request_shape_check CHECK (
  "basePriority" BETWEEN 0 AND 2
  AND "enqueueSequence" >= 0
  AND (("sourceKind" = 'TEST' AND "poolId" IS NULL AND "testTargetId" IS NOT NULL)
    OR ("sourceKind" = 'POOL' AND "poolId" IS NOT NULL AND "testTargetId" IS NULL))
  AND ("deadlineAt" IS NULL OR "deadlineAt" >= "enqueuedAt")
  AND ((state IN ('CANCELLED', 'EXPIRED', 'TERMINAL') AND "terminalAt" IS NOT NULL)
    OR (state IN ('WAITING', 'ADMITTED') AND "terminalAt" IS NULL))
);
ALTER TABLE admission_request DROP CONSTRAINT IF EXISTS admission_request_priority_share_check;
ALTER TABLE admission_request ADD CONSTRAINT admission_request_priority_share_check CHECK (
  "priorityShareId" IS NULL OR "poolId" IS NOT NULL
);
ALTER TABLE capacity_waiter DROP CONSTRAINT IF EXISTS capacity_waiter_shape_check;
ALTER TABLE capacity_waiter ADD CONSTRAINT capacity_waiter_shape_check CHECK (
  "candidateOrder" >= 0
  AND "requestId" <> '' AND "attemptId" <> ''
  AND "enqueueSequence" >= 0
  AND "effectivePriority" BETWEEN 0 AND 2
  AND ("effectiveConcurrencyLimit" IS NULL OR "effectiveConcurrencyLimit" > 0)
  AND ("effectivePoolConcurrencyLimit" IS NULL OR "effectivePoolConcurrencyLimit" > 0)
  AND "effectiveConcurrencyScope" IN ('TEST', 'POOL')
  AND "effectiveConcurrencyScopeId" <> ''
  AND "effectiveReservedSlots" >= 0
  AND ("notBefore" IS NULL OR "deadlineAt" IS NULL OR "deadlineAt" >= "notBefore")
  AND (("poolId" IS NULL) = ("poolMemberId" IS NULL))
);
ALTER TABLE capacity_lease DROP CONSTRAINT IF EXISTS capacity_lease_shape_check;
ALTER TABLE capacity_lease ADD CONSTRAINT capacity_lease_shape_check CHECK (
  priority BETWEEN 0 AND 2
  AND "reservationClass" BETWEEN 0 AND 2
  AND "fencingToken" > 0
  AND "expiresAt" > "acquiredAt"
  AND (("poolId" IS NULL) = ("poolMemberId" IS NULL))
  AND ((state = 'ACTIVE' AND "releasedAt" IS NULL) OR (state <> 'ACTIVE' AND "releasedAt" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_one_admitted_winner
  ON capacity_waiter ("admissionRequestId") WHERE state = 'ADMITTED';
CREATE UNIQUE INDEX IF NOT EXISTS capacity_waiter_unique_test_candidate
  ON capacity_waiter ("admissionRequestId", "capacityId", "executionTargetId")
  WHERE "poolMemberId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS capacity_lease_one_live_attempt
  ON capacity_lease ("admissionRequestId") WHERE state = 'ACTIVE';

-- Admission references: same owner (the pool owner is the principal), waiter/lease capacity =
-- the target's instance, a pool candidate is a member of the request's pool serving the
-- target's model, a TEST candidate is the request's own target. A contributed member's target
-- belongs to its contributor. Waiter policy snapshots equal the pool's routing policy (limits
-- redesign): the pool's class (or the share's class recorded on the request), the pool cap,
-- kept slots and borrowing; a contributed member runs BACKGROUND, keeps nothing and may borrow.
-- TEST candidates run NORMAL with no scope limit (D1: direct targets carry no policy).
CREATE OR REPLACE FUNCTION enforce_capacity_reference_consistency()
RETURNS trigger LANGUAGE plpgsql AS $capacity_reference_check$
DECLARE
  request_owner TEXT;
  request_pool TEXT;
  request_test_target TEXT;
  request_base_priority INTEGER;
  request_priority_share TEXT;
  target_found BOOLEAN := false;
  target_owner TEXT;
  target_instance TEXT;
  target_model TEXT;
  member_found BOOLEAN := false;
  member_pool TEXT;
  member_model TEXT;
  member_share TEXT;
  parent_owner TEXT;
BEGIN
  IF TG_TABLE_NAME = 'admission_request' THEN
    IF NEW."poolId" IS NOT NULL THEN
      SELECT "userId" INTO parent_owner FROM pool WHERE id = NEW."poolId";
      IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'admission request pool must have the same owner' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW."testTargetId" IS NOT NULL THEN
      SELECT "userId" INTO parent_owner FROM execution_target WHERE id = NEW."testTargetId";
      IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
        RAISE EXCEPTION 'test admission target must have the same owner' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT "userId", "poolId", "testTargetId", "basePriority", "priorityShareId"
    INTO request_owner, request_pool, request_test_target, request_base_priority, request_priority_share
    FROM admission_request WHERE id = NEW."admissionRequestId";
  SELECT true, "userId", "instanceId", "runtimeModelId"
    INTO target_found, target_owner, target_instance, target_model
    FROM execution_target WHERE id = NEW."executionTargetId";
  IF NEW."poolMemberId" IS NOT NULL THEN
    SELECT true, "poolId", "runtimeModelId", "shareId" INTO member_found, member_pool, member_model, member_share
      FROM pool_member WHERE id = NEW."poolMemberId";
  END IF;
  IF request_owner IS NULL OR request_owner <> NEW."userId" THEN
    RAISE EXCEPTION 'capacity admission references must share their request owner' USING ERRCODE = '23514';
  END IF;
  IF target_found AND (target_instance IS DISTINCT FROM NEW."capacityId"
       OR (target_owner <> NEW."userId" AND NOT (member_found AND member_share IS NOT NULL))) THEN
    RAISE EXCEPTION 'capacity admission target must be the capacity''s model of the owner or a contributor'
      USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME IN ('capacity_waiter', 'capacity_lease') AND NOT EXISTS (
    SELECT 1 FROM admission_request request
     WHERE request.id = NEW."admissionRequestId"
       AND request."requestId" = NEW."requestId" AND request."attemptId" = NEW."attemptId"
  ) THEN
    RAISE EXCEPTION 'capacity request and attempt identity must match the admission request'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."poolMemberId" IS NOT NULL THEN
    IF request_pool IS DISTINCT FROM NEW."poolId"
       OR (member_found AND (member_pool IS DISTINCT FROM NEW."poolId"
         OR (target_found AND member_model IS DISTINCT FROM target_model))) THEN
      RAISE EXCEPTION 'capacity admission pool candidate is inconsistent' USING ERRCODE = '23514';
    END IF;
  ELSIF request_pool IS NOT NULL THEN
    RAISE EXCEPTION 'pool admission requires a pool member candidate' USING ERRCODE = '23514';
  ELSIF request_test_target IS DISTINCT FROM NEW."executionTargetId" THEN
    RAISE EXCEPTION 'test admission candidate must be its source target' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'capacity_waiter' THEN
    IF TG_OP = 'UPDATE' AND (NEW."effectivePriority", NEW."effectiveConcurrencyLimit",
         NEW."effectiveConcurrencyScope", NEW."effectiveConcurrencyScopeId",
         NEW."effectivePoolConcurrencyLimit", NEW."effectiveReservedSlots", NEW."effectiveBorrowReserved")
       IS DISTINCT FROM (OLD."effectivePriority", OLD."effectiveConcurrencyLimit",
         OLD."effectiveConcurrencyScope", OLD."effectiveConcurrencyScopeId",
         OLD."effectivePoolConcurrencyLimit", OLD."effectiveReservedSlots", OLD."effectiveBorrowReserved") THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot is immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW."poolMemberId" IS NOT NULL AND member_found AND NOT EXISTS (
      SELECT 1 FROM pool_routing routing
       WHERE routing."poolId" = NEW."poolId"
         AND ((member_share IS NOT NULL
               AND NEW."effectivePriority" = wsmp_priority_class_rank('BACKGROUND')
               AND NEW."effectiveReservedSlots" = 0
               AND NEW."effectiveBorrowReserved")
           OR (member_share IS NULL
               AND (NEW."effectivePriority" = wsmp_priority_class_rank(routing."priorityClass")
                 OR (request_priority_share IS NOT NULL AND NEW."effectivePriority" = request_base_priority))
               AND NEW."effectiveReservedSlots" = routing."keptSlots"
               AND NEW."effectiveBorrowReserved" = routing."borrowKept"))
         AND NEW."effectiveConcurrencyLimit" IS NOT DISTINCT FROM routing."concurrencyLimit"
         AND NEW."effectiveConcurrencyScope" = 'POOL'
         AND NEW."effectiveConcurrencyScopeId" = NEW."poolId"
         AND NEW."effectivePoolConcurrencyLimit" IS NULL
    ) THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot must match its pool policy' USING ERRCODE = '23514';
    ELSIF NEW."poolMemberId" IS NULL AND NOT (
      NEW."effectivePriority" = wsmp_priority_class_rank('NORMAL')
      AND NEW."effectiveConcurrencyLimit" IS NULL
      AND NEW."effectiveConcurrencyScope" = 'TEST'
      AND NEW."effectiveConcurrencyScopeId" = NEW."executionTargetId"
      AND NEW."effectivePoolConcurrencyLimit" IS NULL
      AND NEW."effectiveReservedSlots" = 0
      AND NEW."effectiveBorrowReserved"
    ) THEN
      RAISE EXCEPTION 'capacity waiter policy snapshot must match the test policy' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$capacity_reference_check$;
DROP TRIGGER IF EXISTS admission_request_reference_consistency ON admission_request;
CREATE TRIGGER admission_request_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "sourceKind", "poolId", "testTargetId" ON admission_request
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();
DROP TRIGGER IF EXISTS capacity_waiter_reference_consistency ON capacity_waiter;
CREATE TRIGGER capacity_waiter_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "admissionRequestId", "requestId", "attemptId", "capacityId",
  "executionTargetId", "poolId", "poolMemberId", "effectivePriority", "effectiveConcurrencyLimit",
  "effectiveConcurrencyScope", "effectiveConcurrencyScopeId", "effectivePoolConcurrencyLimit",
  "effectiveReservedSlots", "effectiveBorrowReserved" ON capacity_waiter
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();
DROP TRIGGER IF EXISTS capacity_lease_reference_consistency ON capacity_lease;
CREATE TRIGGER capacity_lease_reference_consistency
BEFORE INSERT OR UPDATE OF "userId", "admissionRequestId", "requestId", "attemptId", "capacityId",
  "executionTargetId", "poolId", "poolMemberId" ON capacity_lease
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_reference_consistency();

-- A lease/admission is durable evidence of the exact request it authorized.
CREATE OR REPLACE FUNCTION enforce_capacity_history_identity()
RETURNS trigger LANGUAGE plpgsql AS $capacity_history_identity$
BEGIN
  IF TG_TABLE_NAME = 'admission_request' THEN
    IF (NEW.id, NEW."userId", NEW."requestId", NEW."attemptId", NEW."sourceKind", NEW."poolId", NEW."testTargetId")
       IS DISTINCT FROM
       (OLD.id, OLD."userId", OLD."requestId", OLD."attemptId", OLD."sourceKind", OLD."poolId", OLD."testTargetId")
       OR (NEW."relayRequestId" IS DISTINCT FROM OLD."relayRequestId" AND NOT (
         NEW."relayRequestId" IS NULL AND OLD."relayRequestId" IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM relay_request WHERE id = OLD."relayRequestId"))) THEN
      RAISE EXCEPTION 'admission historical request identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF (NEW.id, NEW."userId", NEW."admissionRequestId", NEW."requestId", NEW."attemptId", NEW."capacityId",
         NEW."executionTargetId", NEW."poolId", NEW."poolMemberId", NEW."fencingToken")
        IS DISTINCT FROM
        (OLD.id, OLD."userId", OLD."admissionRequestId", OLD."requestId", OLD."attemptId", OLD."capacityId",
         OLD."executionTargetId", OLD."poolId", OLD."poolMemberId", OLD."fencingToken") THEN
    RAISE EXCEPTION 'capacity lease historical identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$capacity_history_identity$;
DROP TRIGGER IF EXISTS admission_history_identity ON admission_request;
CREATE TRIGGER admission_history_identity BEFORE UPDATE ON admission_request
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_history_identity();
DROP TRIGGER IF EXISTS capacity_lease_history_identity ON capacity_lease;
CREATE TRIGGER capacity_lease_history_identity BEFORE UPDATE ON capacity_lease
FOR EACH ROW EXECUTE FUNCTION enforce_capacity_history_identity();

-- Disposable KV-eviction feedback.
CREATE OR REPLACE FUNCTION capacity_kv_eviction_session_ids_ok(ids text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $kv_eviction_ids$
  SELECT array_position(ids, NULL) IS NULL
     AND NOT EXISTS (SELECT 1 FROM unnest(ids) AS session_id WHERE length(session_id) NOT BETWEEN 1 AND 128);
$kv_eviction_ids$;
ALTER TABLE capacity_kv_eviction DROP CONSTRAINT IF EXISTS capacity_kv_eviction_shape_check;
ALTER TABLE capacity_kv_eviction ADD CONSTRAINT capacity_kv_eviction_shape_check CHECK (
  "cutFraction" >= 0 AND "cutFraction" <= 1
  AND length("capacityId") BETWEEN 1 AND 128
  AND cardinality("sessionIds") <= 16
  AND capacity_kv_eviction_session_ids_ok("sessionIds")
  AND "missCount" >= 0 AND "continuationCount" >= 0 AND "missCount" <= "continuationCount"
  AND "expiresAt" >= "observedAt"
);

-- ── Cache affinity (unchanged in shape; generations come from the instance) ──

CREATE UNIQUE INDEX IF NOT EXISTS cache_affinity_conversation_unique
  ON cache_affinity_record
    ("tenantUserId", "poolId", "executionTargetId", "targetIdentity", "bindingDigest", "conversationDigest")
  WHERE "conversationDigest" IS NOT NULL AND "prefixDigest" IS NULL;
CREATE INDEX IF NOT EXISTS cache_affinity_record_residency
  ON cache_affinity_record ("userId", "executionTargetId", "expiresAt" DESC, id DESC)
  WHERE "prefixDigest" IS NULL;
ALTER TABLE cache_affinity_record DROP CONSTRAINT IF EXISTS cache_affinity_record_shape_check;
ALTER TABLE cache_affinity_record ADD CONSTRAINT cache_affinity_record_shape_check CHECK (
  "digestVersion" >= 5
  AND "prefixDepth" >= 0
  AND ("estimatedTokens" IS NULL OR "estimatedTokens" >= 0)
  AND ("reportedTokens" IS NULL OR "reportedTokens" >= 0)
  AND "expiresAt" > "createdAt"
  AND length("bindingDigest") BETWEEN 32 AND 128
  AND (("prefixDigest" IS NOT NULL AND "prefixDepth" > 0 AND "conversationDigest" IS NULL
        AND length("prefixDigest") BETWEEN 32 AND 128)
    OR ("prefixDigest" IS NULL AND "prefixDepth" = 0 AND "conversationDigest" IS NOT NULL
        AND length("conversationDigest") BETWEEN 32 AND 128))
  AND length("sessionId") BETWEEN 1 AND 128
  AND length(id) BETWEEN 1 AND 128
  AND ("sharedWithSessionId" IS NULL OR length("sharedWithSessionId") BETWEEN 1 AND 128)
  AND length("targetIdentity") BETWEEN 1 AND 2048
  AND ("sharedPrefixTokens" IS NULL OR "sharedPrefixTokens" >= 0)
);
ALTER TABLE cache_affinity_record DROP CONSTRAINT IF EXISTS cache_affinity_record_generation_shape;
ALTER TABLE cache_affinity_record ADD CONSTRAINT cache_affinity_record_generation_shape CHECK (length("cacheGeneration") <= 128);
ALTER TABLE cache_affinity_node DROP CONSTRAINT IF EXISTS cache_affinity_node_generation_shape;
ALTER TABLE cache_affinity_node ADD CONSTRAINT cache_affinity_node_generation_shape CHECK (length("cacheGeneration") <= 128);
ALTER TABLE cache_affinity_node DROP CONSTRAINT IF EXISTS cache_affinity_node_shape_check;
ALTER TABLE cache_affinity_node ADD CONSTRAINT cache_affinity_node_shape_check CHECK (
  depth > 0 AND length("rootDigest") BETWEEN 32 AND 128 AND length("nodeDigest") BETWEEN 32 AND 128
  AND length("sessionId") BETWEEN 1 AND 128
  AND ("estimatedTokens" IS NULL OR "estimatedTokens" >= 0)
  AND ("reportedTokens" IS NULL OR "reportedTokens" >= 0)
);
ALTER TABLE cache_affinity_scope DROP CONSTRAINT IF EXISTS cache_affinity_scope_shape;
ALTER TABLE cache_affinity_scope ADD CONSTRAINT cache_affinity_scope_shape CHECK (
  length("poolId") BETWEEN 1 AND 128 AND length("userId") BETWEEN 1 AND 128 AND length(generation) = 36
);
ALTER TABLE cache_affinity_observer DROP CONSTRAINT IF EXISTS cache_affinity_observer_shape;
ALTER TABLE cache_affinity_observer ADD CONSTRAINT cache_affinity_observer_shape CHECK (
  length("capacityId") BETWEEN 1 AND 128 AND length("userId") BETWEEN 1 AND 128
  AND length("nodeId") BETWEEN 1 AND 128 AND length("instanceHandle") BETWEEN 1 AND 63
  AND length("managerId") = 36 AND length(version) = 36 AND "connectionGeneration" > 0
);
ALTER TABLE cache_affinity_residency_cursor DROP CONSTRAINT IF EXISTS cache_affinity_residency_cursor_singleton;
ALTER TABLE cache_affinity_residency_cursor ADD CONSTRAINT cache_affinity_residency_cursor_singleton CHECK (id = 1);
ALTER TABLE cache_affinity_residency DROP CONSTRAINT IF EXISTS cache_affinity_residency_bound;
ALTER TABLE cache_affinity_residency ADD CONSTRAINT cache_affinity_residency_bound CHECK (
  length("cacheGeneration") <= 128
  AND jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 2000
  AND octet_length(entries::text) <= 4194304
  AND NOT jsonb_path_exists(entries, '$[*] ? (!exists(@.poolId))')
  AND jsonb_typeof("repairEntries") = 'array' AND jsonb_array_length("repairEntries") <= 2000
  AND octet_length("repairEntries"::text) <= 4194304
  AND revision >= 0
);
CREATE INDEX IF NOT EXISTS cache_affinity_record_residency_repair
  ON cache_affinity_record ("userId", "executionTargetId", id) WHERE "prefixDigest" IS NULL;
CREATE INDEX IF NOT EXISTS cache_affinity_record_target_generation_repair
  ON cache_affinity_record ("executionTargetId", "cacheGeneration", id) WHERE "prefixDigest" IS NULL;
CREATE INDEX IF NOT EXISTS cache_affinity_record_physical_generation_repair
  ON cache_affinity_record ("executionTargetId", split_part("cacheGeneration", ':pool:', 1), id)
  WHERE "prefixDigest" IS NULL;
CREATE INDEX IF NOT EXISTS cache_affinity_record_scope_reclaim
  ON cache_affinity_record ("userId", "poolId", split_part("cacheGeneration", ':pool:', 2), id);
CREATE INDEX IF NOT EXISTS cache_affinity_node_scope_reclaim
  ON cache_affinity_node ("userId", "poolId", split_part("cacheGeneration", ':pool:', 2), id);

-- The physical cache generation of a target: its instance's KV incarnation plus the head
-- node's connection generation (a reconnect is a conservative cache boundary). The head node
-- is the always-on runtime's node, or rank 0's node.
CREATE OR REPLACE FUNCTION wsmp_affinity_head_node(instance_id text)
RETURNS text LANGUAGE sql STABLE AS $affinity_head_node$
  SELECT COALESCE(r."nodeId", (SELECT "nodeId" FROM instance_rank WHERE "instanceId" = i.id AND rank = 0))
    FROM runtime_instance i JOIN runtime r ON r.id = i."runtimeId"
   WHERE i.id = instance_id
$affinity_head_node$;
CREATE OR REPLACE FUNCTION wsmp_affinity_generation(target_id text)
RETURNS text LANGUAGE sql STABLE AS $affinity_generation$
  SELECT COALESCE(i."cacheGeneration", '') ||
    CASE WHEN COALESCE(n."connectionGeneration", 0) = 0 THEN ''
      ELSE ':connection:' || n."connectionGeneration"::text END
    FROM execution_target t
    LEFT JOIN runtime_instance i ON i.id = t."instanceId"
    LEFT JOIN node n ON n.id = wsmp_affinity_head_node(i.id)
   WHERE t.id = target_id
$affinity_generation$;
-- Confidence is shared across processes: no live observer may be pending or expired, and the
-- connected head node must have an observer for its current connection.
CREATE OR REPLACE FUNCTION wsmp_affinity_generation_ready(target_id text)
RETURNS boolean LANGUAGE sql STABLE AS $affinity_ready$
  SELECT NOT EXISTS (
    SELECT 1 FROM cache_affinity_observer o
     WHERE o."capacityId" = t."instanceId" AND NOT o.retired
       AND (o.pending OR o."validUntil" <= statement_timestamp())
  ) AND NOT EXISTS (
    SELECT 1 FROM runtime_instance i JOIN node n ON n.id = wsmp_affinity_head_node(i.id)
     WHERE i.id = t."instanceId" AND n."connectionGeneration" > 0
       AND NOT EXISTS (
         SELECT 1 FROM cache_affinity_observer o
          WHERE o."capacityId" = i.id AND o."nodeId" = n.id AND o."instanceHandle" = i.handle
            AND o."connectionGeneration" = n."connectionGeneration")
  ) FROM execution_target t WHERE t.id = target_id
$affinity_ready$;
CREATE OR REPLACE FUNCTION wsmp_affinity_scope_generation(target_id text, pool_id text)
RETURNS text LANGUAGE sql STABLE AS $affinity_scope_generation$
  SELECT wsmp_affinity_generation(target_id) || COALESCE(
    (SELECT ':pool:' || generation FROM cache_affinity_scope WHERE "poolId" = pool_id), '')
$affinity_scope_generation$;

CREATE OR REPLACE FUNCTION enforce_cache_affinity_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $cache_affinity_identity_immutable$
BEGIN
  IF (NEW."userId", NEW."tenantUserId", NEW."poolId", NEW."executionTargetId", NEW."cacheGeneration",
      NEW."targetIdentity", NEW."digestVersion", NEW."bindingDigest", NEW."prefixDigest",
      NEW."conversationDigest", NEW."prefixDepth")
     IS DISTINCT FROM
     (OLD."userId", OLD."tenantUserId", OLD."poolId", OLD."executionTargetId", OLD."cacheGeneration",
      OLD."targetIdentity", OLD."digestVersion", OLD."bindingDigest", OLD."prefixDigest",
      OLD."conversationDigest", OLD."prefixDepth") THEN
    RAISE EXCEPTION 'cache affinity identity and HMAC digests are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cache_affinity_identity_immutable$;
DROP TRIGGER IF EXISTS cache_affinity_identity_immutable ON cache_affinity_record;
CREATE TRIGGER cache_affinity_identity_immutable BEFORE UPDATE ON cache_affinity_record
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_identity_immutable();

-- The pool principal owns affinity rows; a target of another owner needs a contributed member
-- (a can-contribute share) of that pool for the target's served model.
CREATE OR REPLACE FUNCTION enforce_cache_affinity_owner()
RETURNS trigger LANGUAGE plpgsql AS $cache_affinity_owner$
DECLARE
  parent_owner TEXT;
  target_model TEXT;
BEGIN
  SELECT "userId" INTO parent_owner FROM pool WHERE id = NEW."poolId";
  IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" THEN
    RAISE EXCEPTION 'cache affinity pool must belong to its owner' USING ERRCODE = '23514';
  END IF;
  SELECT "userId", "runtimeModelId" INTO parent_owner, target_model
    FROM execution_target WHERE id = NEW."executionTargetId";
  IF FOUND AND parent_owner IS DISTINCT FROM NEW."userId" AND NOT EXISTS (
    SELECT 1 FROM pool_member m JOIN share s ON s.id = m."shareId"
     WHERE m."poolId" = NEW."poolId" AND m."runtimeModelId" = target_model
       AND s."canContribute" AND s."granteeUserId" = parent_owner AND s."ownerUserId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'cache affinity target requires its owner or a contributed member' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cache_affinity_owner$;
DROP TRIGGER IF EXISTS cache_affinity_owner ON cache_affinity_record;
CREATE TRIGGER cache_affinity_owner BEFORE INSERT ON cache_affinity_record
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_owner();
DROP TRIGGER IF EXISTS cache_affinity_node_owner ON cache_affinity_node;
CREATE TRIGGER cache_affinity_node_owner BEFORE INSERT ON cache_affinity_node
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_owner();

CREATE OR REPLACE FUNCTION enforce_cache_affinity_node_immutable()
RETURNS trigger LANGUAGE plpgsql AS $cache_affinity_node_immutable$
BEGIN
  IF (NEW."userId", NEW."tenantUserId", NEW."poolId", NEW."executionTargetId", NEW."cacheGeneration",
      NEW."rootDigest", NEW."nodeDigest", NEW.depth, NEW."sessionId") IS DISTINCT FROM
    (OLD."userId", OLD."tenantUserId", OLD."poolId", OLD."executionTargetId", OLD."cacheGeneration",
      OLD."rootDigest", OLD."nodeDigest", OLD.depth, OLD."sessionId") THEN
    RAISE EXCEPTION 'cache affinity node identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$cache_affinity_node_immutable$;
DROP TRIGGER IF EXISTS cache_affinity_node_immutable ON cache_affinity_node;
CREATE TRIGGER cache_affinity_node_immutable BEFORE UPDATE ON cache_affinity_node
FOR EACH ROW EXECUTE FUNCTION enforce_cache_affinity_node_immutable();

-- Each distinct generation of a source statement is checked once against the live graph.
CREATE OR REPLACE FUNCTION enforce_cache_affinity_generation_statement()
RETURNS trigger LANGUAGE plpgsql AS $affinity_generation_statement$
DECLARE source_generation RECORD;
BEGIN
  FOR source_generation IN
    SELECT DISTINCT "executionTargetId", "poolId", "cacheGeneration", "userId", "tenantUserId" FROM generation_rows
  LOOP
    IF EXISTS (SELECT 1 FROM "user" u WHERE u.id IN (source_generation."userId", source_generation."tenantUserId")
         AND u."deletionGeneration" IS NOT NULL)
       OR wsmp_affinity_generation_ready(source_generation."executionTargetId") = false
       OR source_generation."cacheGeneration" IS DISTINCT FROM
         COALESCE(wsmp_affinity_scope_generation(source_generation."executionTargetId", source_generation."poolId"), '') THEN
      RAISE EXCEPTION 'cache affinity generation has reset' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NULL;
END
$affinity_generation_statement$;
DROP TRIGGER IF EXISTS cache_affinity_generation_insert ON cache_affinity_record;
CREATE TRIGGER cache_affinity_generation_insert AFTER INSERT ON cache_affinity_record
REFERENCING NEW TABLE AS generation_rows FOR EACH STATEMENT
EXECUTE FUNCTION enforce_cache_affinity_generation_statement();
DROP TRIGGER IF EXISTS cache_affinity_generation_update ON cache_affinity_record;
CREATE TRIGGER cache_affinity_generation_update AFTER UPDATE ON cache_affinity_record
REFERENCING NEW TABLE AS generation_rows FOR EACH STATEMENT
EXECUTE FUNCTION enforce_cache_affinity_generation_statement();
DROP TRIGGER IF EXISTS cache_affinity_generation_insert ON cache_affinity_node;
CREATE TRIGGER cache_affinity_generation_insert AFTER INSERT ON cache_affinity_node
REFERENCING NEW TABLE AS generation_rows FOR EACH STATEMENT
EXECUTE FUNCTION enforce_cache_affinity_generation_statement();
DROP TRIGGER IF EXISTS cache_affinity_generation_update ON cache_affinity_node;
CREATE TRIGGER cache_affinity_generation_update AFTER UPDATE ON cache_affinity_node
REFERENCING NEW TABLE AS generation_rows FOR EACH STATEMENT
EXECUTE FUNCTION enforce_cache_affinity_generation_statement();

-- Residency: an optional, bounded projection of new-conversation footprints per target.
CREATE OR REPLACE FUNCTION wsmp_affinity_residency_merge(previous jsonb, added jsonb, removed text[])
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $residency_merge$
  SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'expiresAt')::timestamp DESC, e->>'id' DESC), '[]'::jsonb)
  FROM (
    SELECT e FROM (
      SELECT e FROM jsonb_array_elements(previous) e WHERE NOT (e->>'id' = ANY(removed))
      UNION ALL
      SELECT e FROM jsonb_array_elements(added) e
    ) candidates
    ORDER BY (e->>'expiresAt')::timestamp DESC, e->>'id' DESC LIMIT 2000
  ) bounded
$residency_merge$;
CREATE OR REPLACE FUNCTION wsmp_affinity_residency_change(
  owner_id text, target_id text, removed text[], added jsonb, invalidated text[]
) RETURNS void LANGUAGE plpgsql AS $residency_change$
DECLARE bucket cache_affinity_residency%ROWTYPE; physical_owner text; generation text;
BEGIN
  SELECT "userId" INTO physical_owner FROM execution_target WHERE id = target_id;
  IF physical_owner IS NULL THEN
    SELECT "userId" INTO physical_owner FROM cache_affinity_residency WHERE "executionTargetId" = target_id;
  END IF;
  physical_owner := COALESCE(physical_owner, owner_id);
  IF NOT pg_try_advisory_xact_lock(hashtextextended('wsmp:residency:' || target_id, 0)) THEN
    RAISE EXCEPTION 'cache residency target is busy' USING ERRCODE = '55P03';
  END IF;
  INSERT INTO cache_affinity_residency ("executionTargetId", "userId")
    VALUES (target_id, physical_owner) ON CONFLICT ("executionTargetId") DO NOTHING;
  SELECT * INTO STRICT bucket FROM cache_affinity_residency
    WHERE "executionTargetId" = target_id FOR UPDATE NOWAIT;
  IF bucket."userId" IS DISTINCT FROM physical_owner THEN
    RAISE EXCEPTION 'cache residency target owner mismatch' USING ERRCODE = '23514';
  END IF;
  generation := COALESCE(wsmp_affinity_generation(target_id), bucket."cacheGeneration");
  IF bucket."cacheGeneration" IS DISTINCT FROM generation THEN
    bucket."cacheGeneration" := generation;
    bucket.entries := '[]'::jsonb;
    bucket.complete := true;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(added) e
    WHERE split_part(COALESCE(e->>'cacheGeneration', ''), ':pool:', 1) IS DISTINCT FROM bucket."cacheGeneration") THEN
    RAISE EXCEPTION 'cache affinity generation has reset' USING ERRCODE = '23514';
  END IF;
  UPDATE cache_affinity_residency SET
    "cacheGeneration" = bucket."cacheGeneration",
    entries = wsmp_affinity_residency_merge(bucket.entries, added, removed),
    complete = bucket.complete AND NOT (
      jsonb_array_length(bucket.entries) = 2000 AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(bucket.entries) e WHERE e->>'id' = ANY(invalidated))),
    revision = bucket.revision + 1,
    "repairEntries" = '[]'::jsonb, "repairCursor" = NULL,
    "repairAfter" = clock_timestamp()
  WHERE "executionTargetId" = target_id;
END
$residency_change$;
CREATE OR REPLACE FUNCTION wsmp_affinity_residency_insert()
RETURNS trigger LANGUAGE plpgsql AS $residency_insert$
DECLARE scope record; added jsonb;
BEGIN
  FOR scope IN SELECT min("userId") AS "userId", "executionTargetId" FROM new_records
    WHERE "prefixDigest" IS NULL GROUP BY "executionTargetId" ORDER BY "executionTargetId"
  LOOP
    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO added FROM (
      SELECT id, "expiresAt", "sessionId", "estimatedTokens" AS tokens, "cacheGeneration", "poolId",
        "sharedWithSessionId", "sharedPrefixTokens"
      FROM new_records WHERE "prefixDigest" IS NULL AND "executionTargetId" = scope."executionTargetId"
      ORDER BY "expiresAt" DESC, id DESC LIMIT 2000
    ) r;
    PERFORM wsmp_affinity_residency_change(scope."userId", scope."executionTargetId", ARRAY[]::text[], added, ARRAY[]::text[]);
  END LOOP;
  RETURN NULL;
END
$residency_insert$;
CREATE OR REPLACE FUNCTION wsmp_affinity_residency_update()
RETURNS trigger LANGUAGE plpgsql AS $residency_update$
DECLARE scope record; added jsonb; removed text[]; invalidated text[];
BEGIN
  FOR scope IN SELECT min("userId") AS "userId", "executionTargetId" FROM new_records
    WHERE "prefixDigest" IS NULL GROUP BY "executionTargetId" ORDER BY "executionTargetId"
  LOOP
    SELECT array_agg(n.id), COALESCE(array_agg(n.id) FILTER (WHERE n."expiresAt" < o."expiresAt"), ARRAY[]::text[])
      INTO removed, invalidated FROM new_records n JOIN old_records o USING (id)
      WHERE n."prefixDigest" IS NULL AND n."executionTargetId" = scope."executionTargetId";
    SELECT COALESCE(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO added FROM (
      SELECT id, "expiresAt", "sessionId", "estimatedTokens" AS tokens, "cacheGeneration", "poolId",
        "sharedWithSessionId", "sharedPrefixTokens"
      FROM new_records WHERE "prefixDigest" IS NULL AND "executionTargetId" = scope."executionTargetId"
      ORDER BY "expiresAt" DESC, id DESC LIMIT 2000
    ) r;
    PERFORM wsmp_affinity_residency_change(scope."userId", scope."executionTargetId", removed, added, invalidated);
  END LOOP;
  RETURN NULL;
END
$residency_update$;
CREATE OR REPLACE FUNCTION wsmp_affinity_residency_delete()
RETURNS trigger LANGUAGE plpgsql AS $residency_delete$
DECLARE scope record;
BEGIN
  FOR scope IN SELECT "executionTargetId" FROM old_records
    WHERE "prefixDigest" IS NULL GROUP BY "executionTargetId" ORDER BY "executionTargetId"
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended('wsmp:residency:' || scope."executionTargetId", 0)) THEN
      RAISE EXCEPTION 'cache residency target is busy' USING ERRCODE = '55P03';
    END IF;
    PERFORM 1 FROM cache_affinity_residency WHERE "executionTargetId" = scope."executionTargetId" FOR UPDATE NOWAIT;
  END LOOP;
  UPDATE cache_affinity_residency SET entries = '[]'::jsonb, complete = false,
    "repairEntries" = '[]'::jsonb, "repairCursor" = NULL,
    revision = revision + 1, "repairAfter" = clock_timestamp()
  WHERE "executionTargetId" IN (SELECT "executionTargetId" FROM old_records WHERE "prefixDigest" IS NULL);
  RETURN NULL;
END
$residency_delete$;
DROP TRIGGER IF EXISTS cache_affinity_residency_insert ON cache_affinity_record;
CREATE TRIGGER cache_affinity_residency_insert AFTER INSERT ON cache_affinity_record
  REFERENCING NEW TABLE AS new_records FOR EACH STATEMENT EXECUTE FUNCTION wsmp_affinity_residency_insert();
DROP TRIGGER IF EXISTS cache_affinity_residency_update ON cache_affinity_record;
CREATE TRIGGER cache_affinity_residency_update AFTER UPDATE ON cache_affinity_record
  REFERENCING OLD TABLE AS old_records NEW TABLE AS new_records FOR EACH STATEMENT EXECUTE FUNCTION wsmp_affinity_residency_update();
DROP TRIGGER IF EXISTS cache_affinity_residency_delete ON cache_affinity_record;
CREATE TRIGGER cache_affinity_residency_delete AFTER DELETE ON cache_affinity_record
  REFERENCING OLD TABLE AS old_records FOR EACH STATEMENT EXECUTE FUNCTION wsmp_affinity_residency_delete();

-- ── Responses stickiness ──

-- A cloud or own-key binding is a complete, immutable provider snapshot; a local one has none.
ALTER TABLE response_stickiness_record DROP CONSTRAINT IF EXISTS response_stickiness_provider_binding_check;
ALTER TABLE response_stickiness_record ADD CONSTRAINT response_stickiness_provider_binding_check CHECK (
  (route IS NULL OR route IN ('local', 'cloud', 'own_key'))
  AND ((route IS DISTINCT FROM 'cloud' AND route IS DISTINCT FROM 'own_key'
        AND "providerAccountId" IS NULL AND "providerModelId" IS NULL
        AND "providerEndpointIdentity" IS NULL AND "providerEndpointVersion" IS NULL
        AND "providerUpstreamModelId" IS NULL AND "upstreamResponseIdDigest" IS NULL)
    OR (route IN ('cloud', 'own_key')
        AND "providerAccountId" IS NOT NULL AND "providerModelId" IS NOT NULL
        AND "selectedTargetId" IS NOT NULL AND "poolId" IS NOT NULL
        AND length("providerEndpointIdentity") > 0 AND "providerEndpointVersion" > 0
        AND length("providerUpstreamModelId") > 0
        AND "nativeSurface" = 'OPENAI_RESPONSES'
        AND length("upstreamResponseIdDigest") BETWEEN 32 AND 128))
  AND (route IS DISTINCT FROM 'own_key' OR "shareId" IS NOT NULL)
);
CREATE OR REPLACE FUNCTION enforce_response_stickiness_provider_binding_immutable()
RETURNS trigger LANGUAGE plpgsql AS $response_stickiness_binding_immutable$
BEGIN
  IF (OLD.route IN ('cloud', 'own_key') OR NEW.route IN ('cloud', 'own_key'))
     AND (NEW."userId", NEW."apiKeyId", NEW."routingKeyDigest", NEW."poolId", NEW."selectedTargetId",
          NEW."providerAccountId", NEW."providerModelId", NEW."providerEndpointIdentity",
          NEW."providerEndpointVersion", NEW."providerUpstreamModelId", NEW."shareId",
          NEW."nativeSurface", NEW."upstreamResponseIdDigest", NEW.route)
       IS DISTINCT FROM
         (OLD."userId", OLD."apiKeyId", OLD."routingKeyDigest", OLD."poolId", OLD."selectedTargetId",
          OLD."providerAccountId", OLD."providerModelId", OLD."providerEndpointIdentity",
          OLD."providerEndpointVersion", OLD."providerUpstreamModelId", OLD."shareId",
          OLD."nativeSurface", OLD."upstreamResponseIdDigest", OLD.route) THEN
    RAISE EXCEPTION 'provider Responses binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$response_stickiness_binding_immutable$;
DROP TRIGGER IF EXISTS response_stickiness_provider_binding_immutable ON response_stickiness_record;
CREATE TRIGGER response_stickiness_provider_binding_immutable BEFORE UPDATE ON response_stickiness_record
FOR EACH ROW EXECUTE FUNCTION enforce_response_stickiness_provider_binding_immutable();

-- ── Request telemetry (trimmed columns; the attempt rules land with B4) ──

ALTER TABLE relay_request DROP CONSTRAINT IF EXISTS relay_request_execution_telemetry_check;
ALTER TABLE relay_request ADD CONSTRAINT relay_request_execution_telemetry_check CHECK (
  ("queueWaitMs" IS NULL OR "queueWaitMs" >= 0)
  AND ("durationMs" IS NULL OR "durationMs" >= 0)
  AND ("affinityWaitMs" IS NULL OR "affinityWaitMs" >= 0)
  AND ("sidecarLatencyMs" IS NULL OR "sidecarLatencyMs" >= 0)
  AND "attemptCount" >= 0
  AND (route IS NULL OR route IN ('local', 'cloud', 'own_key'))
  AND (rejection IS NULL OR rejection ~ '^[a-z0-9_]{1,64}$')
  AND (NOT external OR "poolId" IS NOT NULL)
  AND ((source = 'SIDECAR') = ("parentRequestId" IS NOT NULL))
  AND (source <> 'API_KEY' OR ("poolId" IS NOT NULL AND "runtimeModelId" IS NULL))
  AND (status <> 'PENDING' OR "completedAt" IS NULL)
  AND ("upstreamErrorExcerpt" IS NULL OR char_length("upstreamErrorExcerpt") BETWEEN 1 AND 300)
);
-- Usage attribution, derived and pinned: the requested pool's owner, else the served model's
-- owner (direct tests), else the requester. Never trusted from the writer.
CREATE OR REPLACE FUNCTION derive_relay_request_resource_owner()
RETURNS trigger LANGUAGE plpgsql AS $relay_resource_owner$
DECLARE
  owner_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW."resourceOwnerUserId" := OLD."resourceOwnerUserId";
    RETURN NEW;
  END IF;
  IF NEW."poolId" IS NOT NULL THEN
    SELECT "userId" INTO owner_id FROM pool WHERE id = NEW."poolId";
  ELSIF NEW."runtimeModelId" IS NOT NULL THEN
    SELECT "userId" INTO owner_id FROM runtime_model WHERE id = NEW."runtimeModelId";
  END IF;
  NEW."resourceOwnerUserId" := COALESCE(owner_id, NEW."userId");
  RETURN NEW;
END;
$relay_resource_owner$;
DROP TRIGGER IF EXISTS a_relay_request_resource_owner ON relay_request;
CREATE TRIGGER a_relay_request_resource_owner
BEFORE INSERT OR UPDATE OF "poolId", "runtimeModelId", "resourceOwnerUserId" ON relay_request
FOR EACH ROW EXECUTE FUNCTION derive_relay_request_resource_owner();
-- The selected target, instance, version and node agree while the target exists.
CREATE OR REPLACE FUNCTION enforce_relay_request_execution_target()
RETURNS trigger LANGUAGE plpgsql AS $relay_request_target$
DECLARE
  target_instance TEXT;
BEGIN
  IF NEW."selectedTargetId" IS NOT NULL AND NEW."selectedInstanceId" IS NOT NULL THEN
    SELECT "instanceId" INTO target_instance FROM execution_target WHERE id = NEW."selectedTargetId";
    IF FOUND AND target_instance IS DISTINCT FROM NEW."selectedInstanceId" THEN
      RAISE EXCEPTION 'selected target and instance disagree' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$relay_request_target$;
DROP TRIGGER IF EXISTS relay_request_execution_target_consistency ON relay_request;
CREATE TRIGGER relay_request_execution_target_consistency
BEFORE INSERT OR UPDATE OF "selectedTargetId", "selectedInstanceId" ON relay_request
FOR EACH ROW EXECUTE FUNCTION enforce_relay_request_execution_target();

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
    WHEN 'share_invite' THEN ARRAY[row_data ->> 'ownerUserId']
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
    ('fabric', 'id,userId,name', ''),
    ('fabric_member', 'id,userId,fabricId,nodeId,ip', ''),
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
    ('share_invite', 'id,poolId,runtimeId,ownerUserId,email,tokenDigest,shareId,runtimeShareId', ''),
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
