-- Migration fixture data (CI check 4, `pnpm db:check-migrations`).
--
-- Written against the schema right after `0_init`: the released v0.4.3 schema with its
-- hardening (CHECK constraints, triggers, graph-write fences). The check loads it right after
-- 0_init is applied, applies every later migration on top, and runs `0_init.check.sql`, whose
-- statements must each return zero rows. A fixture is pinned to the migration it was written
-- against, so it never has to be rewritten when the schema moves on: rows for a table a new
-- migration touches go in the fixture of the latest migration on the base branch.
--
-- These rows are what a 0.4.3 database can hold and the 1.0 upgrade
-- (20261112000000_upgrade_to_1_0_0) must carry over: runtime instances from before runs existed
-- (runGeneration 0), retired completion capability keys, and a sidecar whose target pool its
-- owner can no longer use. Synthetic data only: no real people, no real secrets.

-- Fixture writer: the deploy/fixture marker satisfies every graph-write fence (as the
-- hardening and its tests do); transaction-local.
SELECT set_config('wsmp.fences', ',*,', true);

INSERT INTO "user" (id, name, email, slug, "emailVerified", image, role, banned, "banReason") VALUES
  ('fx-owner-a', 'Fixture Owner A', 'owner-a@example.test', 'fx-owner-a', true, NULL, 'admin', false, NULL),
  ('fx-owner-b', 'fixture owner b', 'owner-b@example.test', 'fx-owner-b', false, 'https://example.test/b.png', 'user', NULL, NULL),
  ('fx-unicode', 'Zoë Ångström 😀', 'zoe@example.test', 'fx-unicode', true, '', 'user', true, 'spam');

INSERT INTO node (id, "userId", slug, trust) VALUES
  ('fx-node-a1', 'fx-owner-a', 'fx-a1', 'FULL'),
  ('fx-node-b1', 'fx-owner-b', 'fx-b1', 'FULL');

-- A startable runtime and its version.
INSERT INTO runtime (id, "userId", slug, name, kind, origin)
  VALUES ('fx-runtime', 'fx-owner-a', 'fx-runtime', 'Fixture runtime', 'STARTABLE', 'SERVER');
INSERT INTO runtime_version (id, "runtimeId", version, editor, "editorUserId", "contentHash",
  "launchHash", spec, api, engine, "modelType") VALUES
  ('fx-version', 'fx-runtime', 1, 'USER', 'fx-owner-a', repeat('1', 64), repeat('a', 64),
   '{"api":"openai","engine":"vllm","modelType":"llm","launch":{}}'::jsonb, 'OPENAI', 'VLLM', 'LLM');
UPDATE runtime SET "currentVersionId" = 'fx-version' WHERE id = 'fx-runtime';
INSERT INTO runtime_operation (id, "userId", kind, actor, "actorUserId", summary, fingerprint)
  VALUES ('fx-operation', 'fx-owner-a', 'RESTART', 'USER', 'fx-owner-a', '{}', repeat('f', 64));

-- Instances written before runs existed (runGeneration 0) in every state the upgrade's backfill
-- distinguishes, plus one already on a run. Expected after the upgrade (0_init.check.sql):
-- empty → 1, latest → 5 (latest non-health step), starting → 6 and unavailable → 6 (a committed
-- restart not yet prepared is one run ahead), prepared → 5, current stays 9.
INSERT INTO runtime_instance (id, "userId", "runtimeId", "versionId", "launchVersionId", handle,
  "startedBy", "desiredState", phase, "operationId", "runGeneration")
SELECT 'fx-inst-' || name, 'fx-owner-a', 'fx-runtime', 'fx-version', 'fx-version',
  'i-' || lpad(index::text, 12, '0'), 'USER', 'RUNNING', phase::"InstancePhase", operation, run
FROM (VALUES
  ('empty', 1, 'READY', NULL, 0),
  ('latest', 2, 'READY', NULL, 0),
  ('starting', 3, 'STARTING', 'fx-operation', 0),
  ('unavailable', 4, 'UNAVAILABLE', 'fx-operation', 0),
  ('prepared', 5, 'STARTING', 'fx-operation', 0),
  ('current', 6, 'STARTING', 'fx-operation', 9)
) AS cases(name, index, phase, operation, run);
-- Their steps predate the 0.4.3 run-order trigger, which refuses a new step outside the
-- instance's current run: switched off for these inserts only, and back on below.
ALTER TABLE instance_step DISABLE TRIGGER instance_step_run_order;
INSERT INTO instance_step (id, "instanceId", "nodeId", rank, phase, sequence, generation, intent, "intentHash")
SELECT 'fx-step-' || name, 'fx-inst-' || name, 'fx-node-a1', 0, 'START', 500, 5,
  CASE WHEN name = 'prepared' THEN '{"operationId":"fx-operation"}'::jsonb ELSE '{}'::jsonb END,
  repeat('b', 64)
FROM (VALUES ('latest'), ('starting'), ('unavailable'), ('prepared'), ('current')) AS cases(name);
INSERT INTO instance_step (id, "instanceId", "nodeId", rank, phase, sequence, generation, intent, "intentHash")
  VALUES ('fx-step-health', 'fx-inst-latest', 'fx-node-a1', 0, 'HEALTH', 9900, 99, '{}', repeat('b', 64));
ALTER TABLE instance_step ENABLE TRIGGER instance_step_run_order;

-- Provider models with the retired completion declarations (object and array inventories).
INSERT INTO provider_account (id, "userId", "providerType", label, "baseUrl", "endpointIdentity", "authType")
  VALUES ('fx-account', 'fx-owner-a', 'generic', 'Fixture upstream', 'https://upstream.example.test/v1', 'https://upstream.example.test/v1', 'API_KEY');
INSERT INTO provider_model (id, "userId", "providerAccountId", "upstreamModelId", type,
  "capabilityMetadata", "nativeCapabilities") VALUES
  ('fx-model-object', 'fx-owner-a', 'fx-account', 'model', 'LLM',
   '{"version":1,"protocol":"openai-compatible","completions":{"supported":true},"chatCompletions":{"supported":true}}',
   '{"version":4,"protocol":"openai-compatible","surfaces":{"openaiCompletions":{"operations":["create"]},"openaiChatCompletions":{"operations":["create"]}}}');
INSERT INTO provider_model (id, "userId", "providerAccountId", "upstreamModelId", type, "nativeCapabilities") VALUES
  ('fx-model-array', 'fx-owner-a', 'fx-account', 'array-model', 'LLM',
   '{"surfaces":["openai-chat"],"streaming":true,"completions":true}'),
  ('fx-model-plain', 'fx-owner-a', 'fx-account', 'Plain Model ', 'LLM', NULL);

-- Pools: B shares a vision pool with A; A's chat pool sends images to it through a sidecar.
INSERT INTO pool (id, "userId", slug, name, "modelType") VALUES
  ('fx-pool-a', 'fx-owner-a', 'chat', 'Chat', 'LLM'),
  ('fx-pool-a2', 'fx-owner-a', 'chat-2', 'Chat 2', 'LLM'),
  ('fx-pool-b', 'fx-owner-b', 'vision', 'Vision', 'LLM'),
  ('fx-pool-b2', 'fx-owner-b', 'vision-2', 'Vision 2', 'LLM');
INSERT INTO share (id, "poolId", "ownerUserId", "granteeUserId", "canUse", "canContribute") VALUES
  ('fx-share-kept', 'fx-pool-b', 'fx-owner-b', 'fx-owner-a', true, false),
  ('fx-share-revoked', 'fx-pool-b2', 'fx-owner-b', 'fx-owner-a', true, true);
INSERT INTO pool_sidecar (id, "poolId", input, "targetPoolId") VALUES
  ('fx-sidecar-kept', 'fx-pool-a', 'IMAGE', 'fx-pool-b'),
  ('fx-sidecar-orphan', 'fx-pool-a2', 'IMAGE', 'fx-pool-b2');
-- 0.4.3 left the sidecar in place when its use was revoked; the 1.0 upgrade removes it.
UPDATE share SET "canUse" = false WHERE id = 'fx-share-revoked';

-- Node commands: a running one and a finished one (1.0 adds how they ran; old rows stay null).
INSERT INTO node_command (id, "userId", "nodeId", actor, subject, "startedAt", "endsBy") VALUES
  ('FXAAAAAAAAAAAAAAAAAAAA', 'fx-owner-a', 'fx-node-a1', 'USER', 'hmac-sha256:00 ls', '2026-01-01 00:00:00', '2026-01-01 01:00:00'),
  ('FXBBBBBBBBBBBBBBBBBBBB', 'fx-owner-a', 'fx-node-a1', 'USER', 'hmac-sha256:01 uname -a', '2026-01-01 00:00:00', '2026-01-02 00:00:00');
UPDATE node_command SET state = 'SUCCEEDED', "exitCode" = 0, "finishedAt" = '2026-01-01 00:00:05'
  WHERE id = 'FXBBBBBBBBBBBBBBBBBBBB';

-- Agent credentials of 0.4.3 (one access level each): the 1.0 upgrade turns READ into the read
-- scope and FULL into every scope on all nodes, so each keeps exactly what it could do.
INSERT INTO mcp_grant (id, "userId", "clientId", "referenceId", level, "revokedAt") VALUES
  ('fx-grant-oauth-read', 'fx-owner-a', 'fx-oauth-client', 'fx-ref-read', 'READ', NULL),
  ('fx-grant-oauth-full', 'fx-owner-b', 'fx-oauth-client', 'fx-ref-full', 'FULL', NULL),
  ('fx-grant-oauth-gone', 'fx-owner-a', 'fx-oauth-client', 'fx-ref-gone', 'FULL', '2026-01-02T00:00:00Z'),
  ('fx-grant-pat-read', 'fx-owner-a', 'pat:fx-token-read', 'pat', 'READ', NULL),
  ('fx-grant-pat-full', 'fx-owner-a', 'pat:fx-token-full', 'pat', 'FULL', NULL);
INSERT INTO agent_token (id, "createdAt", "userId", name, level, "lookupPrefix", "secretDigest", "grantId", "expiresAt") VALUES
  ('fx-token-read', '2026-01-01T00:00:00Z', 'fx-owner-a', 'Fixture read token', 'READ', 'fxread01',
   repeat('a', 64), 'fx-grant-pat-read', NULL),
  ('fx-token-full', '2026-01-01T00:00:00Z', 'fx-owner-a', 'Fixture full token', 'FULL', 'fxfull01',
   repeat('b', 64), 'fx-grant-pat-full', '2027-01-01T00:00:00Z');

-- OAuth data from 0.4.x: all scope stores, duplicates, unknown extras, a PAT synthetic client,
-- and expired/revoked tokens. Only exact mcp:write tokens expand; read-only rows keep order.
INSERT INTO oauth_client (id, "clientId", scopes, "clientCredentialsScopes", "redirectUris", contacts, "grantTypes", "responseTypes") VALUES
  ('fx-oauth-client-row', 'fx-oauth-client', ARRAY['offline_access', 'mcp:write', 'mcp:read', 'mcp:files', 'offline_access', 'profile', 'profile'], ARRAY['mcp:write', 'offline_access'], ARRAY['https://client.example.test/callback'], '{}', ARRAY['authorization_code', 'refresh_token'], ARRAY['code']),
  ('fx-oauth-pat-row', 'pat:fx-token-full', ARRAY['mcp:write'], '{}', '{}', '{}', '{}', '{}'),
  ('fx-oauth-read-row', 'fx-read-client', ARRAY['offline_access', 'mcp:read'], '{}', '{}', '{}', '{}', '{}');
INSERT INTO oauth_resource (id, identifier, name, "allowedScopes") VALUES
  ('fx-oauth-resource', 'https://proxy.example.test/mcp', 'Fixture MCP', '["offline_access","mcp:write","mcp:files","offline_access"]'),
  ('fx-oauth-resource-null', 'https://proxy.example.test/unrestricted', 'Fixture unrestricted', NULL),
  ('fx-oauth-resource-read', 'https://proxy.example.test/read', 'Fixture read', '["offline_access","mcp:read"]');
INSERT INTO oauth_consent (id, "clientId", "userId", "referenceId", resources, "requestedUserInfoClaims", scopes) VALUES
  ('fx-oauth-consent', 'fx-oauth-client', 'fx-owner-b', 'fx-ref-full', ARRAY['https://proxy.example.test/mcp'], '{}', ARRAY['offline_access', 'mcp:write', 'mcp:write']);
INSERT INTO oauth_refresh_token (id, token, "clientId", "userId", "referenceId", resources, "requestedUserInfoClaims", scopes, "expiresAt", revoked) VALUES
  ('fx-oauth-refresh', 'fixture-refresh-digest', 'fx-oauth-client', 'fx-owner-b', 'fx-ref-full', ARRAY['https://proxy.example.test/mcp'], '{}', ARRAY['mcp:write', 'offline_access', 'mcp:commands'], '2026-01-01', '2026-01-02');
INSERT INTO oauth_access_token (id, token, "clientId", "userId", "referenceId", "refreshId", resources, "requestedUserInfoClaims", scopes, "expiresAt", revoked) VALUES
  ('fx-oauth-access', 'fixture-access-digest', 'fx-oauth-client', 'fx-owner-b', 'fx-ref-full', 'fx-oauth-refresh', ARRAY['https://proxy.example.test/mcp'], '{}', ARRAY['mcp:files', 'mcp:write', 'offline_access'], '2026-01-01', '2026-01-02');
INSERT INTO verification (id, identifier, value, "expiresAt") VALUES
  ('fx-oauth-code', 'fixture-code-digest', '{"type":"authorization_code","query":{"client_id":"fx-oauth-client","scope":"offline_access mcp:write mcp:files offline_access profile profile","redirect_uri":"https://client.example.test/callback","state":"unchanged"},"sessionId":"fixture-session","userId":"fx-owner-b","referenceId":"fx-ref-full","resource":["https://proxy.example.test/mcp"]}', '2026-01-01'),
  ('fx-verification-plain', 'fixture-otp', 'not JSON', '2026-01-01'),
  ('fx-verification-json', 'fixture-other', '{"scope":"profile","marker":"keep"}', '2026-01-01');
