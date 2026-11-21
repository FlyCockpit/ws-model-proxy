-- Assertions after every migration on top of fixtures/0_init.sql (CI check 4). Each statement
-- selects the rows that are wrong, so each must return zero rows.

-- Every fixture row survives, except the sidecar the upgrade removes.
SELECT 'missing user' AS problem, expected.id FROM (VALUES ('fx-owner-a'), ('fx-owner-b'), ('fx-unicode')) AS expected(id)
 WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = expected.id);
SELECT 'missing instance' AS problem, count(*) FROM runtime_instance WHERE id LIKE 'fx-inst-%' HAVING count(*) <> 6;
SELECT 'missing step' AS problem, count(*) FROM instance_step WHERE id LIKE 'fx-step-%' HAVING count(*) <> 6;
SELECT 'missing model' AS problem, count(*) FROM provider_model WHERE id LIKE 'fx-model-%' HAVING count(*) <> 3;
SELECT 'missing command' AS problem, count(*) FROM node_command WHERE id LIKE 'FX%' HAVING count(*) <> 2;

-- Text that a type change would have to convert keeps its exact bytes.
SELECT 'name changed' AS problem, id, name FROM "user"
 WHERE (id = 'fx-unicode' AND name <> 'Zoë Ångström 😀') OR (id = 'fx-owner-b' AND name <> 'fixture owner b');
SELECT 'model id changed' AS problem, id FROM provider_model
 WHERE id = 'fx-model-plain' AND ("upstreamModelId" <> 'Plain Model ' OR "nativeCapabilities" IS NOT NULL);

-- 1.0 columns: existing rows get the defaults (empty orders) or stay unknown (null).
SELECT 'terminal order default' AS problem, id FROM "user"
 WHERE id LIKE 'fx-%' AND ("terminalTabOrder" <> '{}' OR "terminalNodeOrder" <> '{}');
SELECT 'ran mode on an old command' AS problem, id FROM node_command
 WHERE id LIKE 'FX%' AND ("ranMode" IS NOT NULL OR "ranShell" IS NOT NULL);

-- Runs: positive everywhere; the backfill reproduces the former resolver (latest non-health
-- generation, plus one for a committed STARTING/UNAVAILABLE restart not yet prepared).
SELECT 'run not positive' AS problem, id FROM runtime_instance WHERE "runGeneration" < 1;
SELECT 'run backfill' AS problem, i.id, i."runGeneration" FROM runtime_instance i
  JOIN (VALUES ('fx-inst-empty', 1), ('fx-inst-latest', 5), ('fx-inst-starting', 6),
               ('fx-inst-unavailable', 6), ('fx-inst-prepared', 5), ('fx-inst-current', 9))
       AS expected(id, run) ON expected.id = i.id
 WHERE i."runGeneration" <> expected.run;
SELECT 'run default' AS problem, column_default FROM information_schema.columns
 WHERE table_name = 'runtime_instance' AND column_name = 'runGeneration' AND column_default <> '1';

-- Retired completion declarations are gone; every other key stays.
SELECT 'capabilities' AS problem, id FROM provider_model
 WHERE (id = 'fx-model-object' AND (
          "capabilityMetadata" <> '{"version":1,"protocol":"openai-compatible","chatCompletions":{"supported":true}}'::jsonb
       OR "nativeCapabilities" <> '{"version":4,"protocol":"openai-compatible","surfaces":{"openaiChatCompletions":{"operations":["create"]}}}'::jsonb))
    OR (id = 'fx-model-array' AND "nativeCapabilities" <> '{"surfaces":["openai-chat"],"streaming":true}'::jsonb);

-- A sidecar whose owner can no longer use its target is removed; a usable one stays.
SELECT 'sidecar' AS problem, expected.id FROM (VALUES ('fx-sidecar-kept', true), ('fx-sidecar-orphan', false)) AS expected(id, present)
 WHERE EXISTS (SELECT 1 FROM pool_sidecar s WHERE s.id = expected.id) <> expected.present;

-- The 0.4.x hardening version gate does not survive the upgrade.
SELECT 'legacy gate' AS problem, proname FROM pg_proc WHERE proname = 'wmp_schema_hardening_state';

-- Agent access levels become scopes: READ → {READ}; FULL → every scope; every node (no list).
SELECT 'missing agent credential' AS problem, count(*) FROM mcp_grant WHERE id LIKE 'fx-grant-%' HAVING count(*) <> 5;
SELECT 'missing agent token' AS problem, count(*) FROM agent_token WHERE id LIKE 'fx-token-%' HAVING count(*) <> 2;
SELECT 'read scopes' AS problem, id, scopes FROM mcp_grant
 WHERE id IN ('fx-grant-oauth-read', 'fx-grant-pat-read') AND scopes::text[] <> ARRAY['READ'];
SELECT 'full scopes' AS problem, id, scopes FROM mcp_grant
 WHERE id IN ('fx-grant-oauth-full', 'fx-grant-oauth-gone', 'fx-grant-pat-full')
   AND NOT (scopes::text[] @> ARRAY['READ', 'POOLS', 'RUNTIMES', 'NODES_MANAGE', 'COMMANDS', 'FILES', 'MODELS_TEST']
            AND cardinality(scopes) = 7);
SELECT 'node allowlist' AS problem, id FROM mcp_grant WHERE id LIKE 'fx-grant-%' AND NOT "allNodes";
SELECT 'node allowlist rows' AS problem, count(*) FROM mcp_grant_node WHERE "grantId" LIKE 'fx-grant-%' HAVING count(*) <> 0;
SELECT 'grant state changed' AS problem, id FROM mcp_grant
 WHERE (id = 'fx-grant-oauth-gone' AND "revokedAt" IS NULL) OR (id <> 'fx-grant-oauth-gone' AND id LIKE 'fx-grant-%' AND "revokedAt" IS NOT NULL);
SELECT 'token changed' AS problem, id FROM agent_token
 WHERE (id = 'fx-token-full' AND ("grantId" <> 'fx-grant-pat-full' OR "expiresAt" <> '2027-01-01T00:00:00Z'))
    OR (id = 'fx-token-read' AND ("grantId" <> 'fx-grant-pat-read' OR "expiresAt" IS NOT NULL));

-- Every OAuth scope store expands in the same deterministic order, without losing extras.
WITH expected AS (
  SELECT ARRAY['mcp:read', 'mcp:pools', 'mcp:runtimes', 'mcp:nodes:manage', 'mcp:commands', 'mcp:files', 'mcp:models:test']::text[] AS full
), actual AS (
  SELECT 'client' AS name, scopes, ARRAY['offline_access', 'profile']::text[] AS extras FROM oauth_client WHERE id = 'fx-oauth-client-row'
  UNION ALL SELECT 'client credentials', "clientCredentialsScopes", ARRAY['offline_access'] FROM oauth_client WHERE id = 'fx-oauth-client-row'
  UNION ALL SELECT 'pat client', scopes, '{}'::text[] FROM oauth_client WHERE id = 'fx-oauth-pat-row'
  UNION ALL SELECT 'consent', scopes, ARRAY['offline_access'] FROM oauth_consent WHERE id = 'fx-oauth-consent'
  UNION ALL SELECT 'refresh', scopes, ARRAY['offline_access'] FROM oauth_refresh_token WHERE id = 'fx-oauth-refresh'
  UNION ALL SELECT 'access', scopes, ARRAY['offline_access'] FROM oauth_access_token WHERE id = 'fx-oauth-access'
  UNION ALL SELECT 'resource', ARRAY(SELECT jsonb_array_elements_text("allowedScopes")), ARRAY['offline_access'] FROM oauth_resource WHERE id = 'fx-oauth-resource'
  UNION ALL SELECT 'code', string_to_array(value::jsonb #>> '{query,scope}', ' '), ARRAY['offline_access', 'profile'] FROM verification WHERE id = 'fx-oauth-code'
)
SELECT 'OAuth scope rewrite' AS problem, actual.name, actual.scopes FROM actual, expected WHERE scopes IS DISTINCT FROM (expected.full || actual.extras);
SELECT 'missing OAuth fixtures' AS problem
 WHERE (SELECT count(*) FROM oauth_client WHERE id LIKE 'fx-oauth-%') <> 3
    OR (SELECT count(*) FROM oauth_resource WHERE id LIKE 'fx-oauth-%') <> 3
    OR NOT EXISTS (SELECT 1 FROM oauth_consent WHERE id = 'fx-oauth-consent')
    OR NOT EXISTS (SELECT 1 FROM oauth_refresh_token WHERE id = 'fx-oauth-refresh')
    OR NOT EXISTS (SELECT 1 FROM oauth_access_token WHERE id = 'fx-oauth-access')
    OR NOT EXISTS (SELECT 1 FROM verification WHERE id = 'fx-oauth-code');
SELECT 'read-only OAuth changed' AS problem, id FROM oauth_client
 WHERE id = 'fx-oauth-read-row' AND (scopes <> ARRAY['offline_access', 'mcp:read'] OR "clientCredentialsScopes" <> '{}');
SELECT 'resource unchanged' AS problem, id FROM oauth_resource
 WHERE (id = 'fx-oauth-resource-null' AND "allowedScopes" IS NOT NULL)
    OR (id = 'fx-oauth-resource-read' AND "allowedScopes" <> '["offline_access","mcp:read"]'::jsonb);
WITH parsed AS (SELECT id, value, "expiresAt", CASE WHEN pg_input_is_valid(value, 'jsonb') THEN value::jsonb END AS document FROM verification)
SELECT 'OAuth state changed' AS problem, id FROM parsed
 WHERE (id = 'fx-oauth-code' AND ((document #- '{query,scope}') <> '{"type":"authorization_code","query":{"client_id":"fx-oauth-client","redirect_uri":"https://client.example.test/callback","state":"unchanged"},"sessionId":"fixture-session","userId":"fx-owner-b","referenceId":"fx-ref-full","resource":["https://proxy.example.test/mcp"]}'::jsonb OR "expiresAt" <> '2026-01-01'))
    OR (id = 'fx-verification-plain' AND value <> 'not JSON')
    OR (id = 'fx-verification-json' AND value <> '{"scope":"profile","marker":"keep"}');
SELECT 'OAuth credential metadata changed' AS problem
 WHERE NOT EXISTS (SELECT 1 FROM oauth_refresh_token WHERE id = 'fx-oauth-refresh' AND revoked = '2026-01-02' AND "expiresAt" = '2026-01-01' AND token = 'fixture-refresh-digest' AND "referenceId" = 'fx-ref-full')
    OR NOT EXISTS (SELECT 1 FROM oauth_access_token WHERE id = 'fx-oauth-access' AND revoked = '2026-01-02' AND "expiresAt" = '2026-01-01' AND token = 'fixture-access-digest' AND "refreshId" = 'fx-oauth-refresh');
-- No legacy scope remains in any scope-bearing OAuth field, including expired/revoked rows.
SELECT 'legacy OAuth scope remains' AS problem, id FROM (
  SELECT id FROM oauth_client WHERE 'mcp:write' = ANY(scopes) OR 'mcp:write' = ANY("clientCredentialsScopes")
  UNION ALL SELECT id FROM oauth_consent WHERE 'mcp:write' = ANY(scopes)
  UNION ALL SELECT id FROM oauth_access_token WHERE 'mcp:write' = ANY(scopes)
  UNION ALL SELECT id FROM oauth_refresh_token WHERE 'mcp:write' = ANY(scopes)
  UNION ALL SELECT id FROM oauth_resource WHERE "allowedScopes" ? 'mcp:write'
  UNION ALL SELECT id FROM verification
    WHERE 'mcp:write' = ANY(string_to_array((CASE WHEN pg_input_is_valid(value, 'jsonb') THEN value::jsonb END) #>> '{query,scope}', ' '))
) AS leftovers;
