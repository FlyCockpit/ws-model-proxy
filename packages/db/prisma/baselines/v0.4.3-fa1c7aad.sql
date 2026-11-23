-- The last 0.4.x schema deployed from the default branch (commit fa1c7aad, after v0.4.3, before
-- migrations existed): the v0.4.3 schema plus nine nullable columns and five changed hardening
-- objects. Never applied to a database. The deploy runner adopts a database without migration
-- history when its schema equals what 0_init creates, or what 0_init then this file create
-- (scripts/db/lib/baseline.mjs); either way it records 0_init as applied, and the 1.0 upgrade
-- migration brings both to 1.0 (its column adds are IF NOT EXISTS for these columns).
--
-- Copied verbatim, frozen: the columns from Prisma's diff of the v0.4.3 schema to fa1c7aad's,
-- the rest from fa1c7aad's packages/db/prisma/schema-hardening.sql. Never edit it.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "terminalNodeOrder" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "terminalTabOrder" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "node_command" ADD COLUMN     "ranMode" TEXT,
ADD COLUMN     "ranShell" TEXT;

-- AlterTable
ALTER TABLE "node_agent_update" ADD COLUMN     "artifactSha256" TEXT,
ADD COLUMN     "availableGeneration" INTEGER,
ADD COLUMN     "availableVersion" TEXT;

-- AlterTable
ALTER TABLE "runtime_model" ADD COLUMN     "declaredReasoning" BOOLEAN,
ADD COLUMN     "declaredTools" BOOLEAN;

-- fa1c7aad's schema-hardening.sql: the objects that differ from v0.4.3's.
ALTER TABLE node DROP CONSTRAINT IF EXISTS node_trust_lower_shape;
-- A pending lowering names who asked. Once the node confirms it, the request time clears and who
-- asked stays, so the node's page can say who lowered it (`nodeTrustView`); the relay clears it
-- on any other trust change (`trustLowerColumns`, apps/server/src/relay/registration.ts).
ALTER TABLE node ADD CONSTRAINT node_trust_lower_shape CHECK (
  "trustLowerRequestedAt" IS NULL OR "trustLowerRequestedBy" IS NOT NULL
);
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
  -- How it ran: a shell names itself; a program started directly may still name cmd (a .bat).
  AND ("ranMode" IS NULL OR "ranMode" IN ('shell', 'direct'))
  AND ("ranShell" IS NULL OR ("ranMode" IS NOT NULL AND "ranShell" ~ '^[a-z][a-z0-9_-]{0,31}$'))
  AND ("ranMode" IS DISTINCT FROM 'shell' OR "ranShell" IS NOT NULL)
);
CREATE OR REPLACE FUNCTION enforce_node_command_transition()
RETURNS trigger LANGUAGE plpgsql AS $node_command_transition$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'exitCode', 'signal', 'finishedAt', 'updatedAt', 'ranMode', 'ranShell']::text[])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'exitCode', 'signal', 'finishedAt', 'updatedAt', 'ranMode', 'ranShell']::text[]) THEN
    RAISE EXCEPTION 'a node command keeps its identity' USING ERRCODE = '55000';
  END IF;
  -- How it ran is recorded once, when the node started it.
  IF OLD."ranMode" IS NOT NULL AND (NEW."ranMode", NEW."ranShell")
      IS DISTINCT FROM (OLD."ranMode", OLD."ranShell") THEN
    RAISE EXCEPTION 'a node command keeps how it ran' USING ERRCODE = '55000';
  END IF;
  IF OLD.state <> 'RUNNING' AND (NEW.state, NEW."exitCode", NEW.signal, NEW."finishedAt")
      IS DISTINCT FROM (OLD.state, OLD."exitCode", OLD.signal, OLD."finishedAt") THEN
    RAISE EXCEPTION 'a finished node command stays finished' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$node_command_transition$;
-- The grantee's own-key model is the grantee's; clearing canContribute removes the members the
-- share contributed; clearing canUse removes the grantee's API-key entries for the pool and the
-- sidecars of the grantee's pools that target it (enforce_pool_sidecar_target checks only on
-- write, so a sidecar must not outlive the use it was allowed by).
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
      DELETE FROM pool_sidecar ps USING pool p -- policy: bounded-delete
       WHERE ps."poolId" = p.id AND p."userId" = NEW."granteeUserId" AND ps."targetPoolId" = NEW."poolId";
    END IF;
  END IF;
  RETURN NEW;
END;
$share_consistency$;
CREATE OR REPLACE FUNCTION share_delete_cleanup()
RETURNS trigger LANGUAGE plpgsql AS $share_delete_cleanup$
BEGIN
  DELETE FROM api_key_pool kp USING api_key k -- policy: bounded-delete
   WHERE kp."apiKeyId" = k.id AND k."userId" = OLD."granteeUserId" AND kp."poolId" = OLD."poolId";
  -- The grantee's sidecars targeting the pool go with the share (see enforce_share_consistency).
  DELETE FROM pool_sidecar ps USING pool p -- policy: bounded-delete
   WHERE ps."poolId" = p.id AND p."userId" = OLD."granteeUserId" AND ps."targetPoolId" = OLD."poolId";
  RETURN OLD;
END;
$share_delete_cleanup$;
