-- Assertions after every migration on top of fixtures/20261112000000_upgrade_to_1_0_0.sql
-- (CI check 4). Each statement selects the rows that are wrong, so each must return zero rows.

SELECT 'missing ledger row' AS problem, count(*) FROM usage_ledger WHERE id LIKE 'fx-ledger-%'
 HAVING count(*) <> 2;

-- The split adds columns only: every accounting value of an existing revision is unchanged.
SELECT 'ledger accounting changed' AS problem, l.id FROM usage_ledger l
  JOIN (VALUES ('fx-ledger-audio', 75::bigint, 31::bigint, 20::bigint, 10::bigint, 14::bigint, 150::bigint,
                0.000123456::numeric, repeat('a', 64)),
               ('fx-ledger-plain', 12, 7, NULL, NULL, NULL, 19, 0.000001, repeat('b', 64)))
       AS expected(id, input, output, cache_read, reasoning, additional, billable, cost, hash)
    ON expected.id = l.id
 WHERE l."inputTokens" IS DISTINCT FROM expected.input
    OR l."outputTokens" IS DISTINCT FROM expected.output
    OR l."cacheReadTokens" IS DISTINCT FROM expected.cache_read
    OR l."reasoningTokens" IS DISTINCT FROM expected.reasoning
    OR l."additionalBillableTokens" IS DISTINCT FROM expected.additional
    OR l."billableTotal" IS DISTINCT FROM expected.billable
    OR l."settledCost" IS DISTINCT FROM expected.cost
    OR l."payloadHash" IS DISTINCT FROM expected.hash
    OR l."rawUsage" -> 'prompt_tokens_details' ->> 'audio_tokens' IS DISTINCT FROM
       CASE WHEN l.id = 'fx-ledger-audio' THEN '5' END;

-- Rows written before the split have no sides (the append-only ledger is never backfilled).
SELECT 'legacy ledger row has a side' AS problem, id FROM usage_ledger
 WHERE id LIKE 'fx-ledger-%'
   AND ("additionalInputTokens" IS NOT NULL OR "additionalOutputTokens" IS NOT NULL);
