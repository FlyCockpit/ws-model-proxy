-- Migration fixture data (CI check 4, `pnpm db:check-migrations`), written against the schema
-- right after `20261112000000_upgrade_to_1_0_0`. See 0_init.sql for how fixtures work.
--
-- Usage ledger revisions from before the additional tokens were split by side
-- (20261122155508_split_additional_tokens): one mixed `additionalBillableTokens` total with the
-- provider's raw usage beside it, and one without additional tokens. The ledger is append-only,
-- so the split columns stay NULL on these rows; readers attribute the total from `rawUsage`.
-- Synthetic data only.

SELECT set_config('wsmp.fences', ',*,', true);

INSERT INTO usage_ledger (id, "userId", "providerAccountId", "providerModelId", "requestId",
  "attemptId", "fencingToken", "inputTokens", "outputTokens", "cacheReadTokens",
  "reasoningTokens", "additionalBillableTokens", "reportedTotalTokens", "billableTotal",
  "categoriesComplete", "observationComplete", "rawUsage", "settledCost", currency,
  "pricingVersion", "accountingVersion", "payloadHash", "usageKnown", "costKnown",
  "terminalReason", confidence) VALUES
  ('fx-ledger-audio', 'fx-owner-a', 'fx-account', 'fx-model', 'fx-request-1', 'fx-attempt-1', 1,
   75, 31, 20, 10, 14, 150, 150, true, true,
   '{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"prompt_tokens_details":{"cached_tokens":20,"audio_tokens":5},"completion_tokens_details":{"reasoning_tokens":10,"audio_tokens":3,"accepted_prediction_tokens":4,"rejected_prediction_tokens":2}}'::jsonb,
   0.000123456, 'USD', 'v1', 'provider-billable-v1', repeat('a', 64), true, true,
   'COMPLETED', 'REPORTED'),
  ('fx-ledger-plain', 'fx-owner-a', 'fx-account', 'fx-model', 'fx-request-2', 'fx-attempt-2', 1,
   12, 7, NULL, NULL, NULL, 19, 19, true, true,
   '{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}'::jsonb,
   0.000001, 'USD', 'v1', 'provider-billable-v1', repeat('b', 64), true, true,
   'COMPLETED', 'REPORTED');
