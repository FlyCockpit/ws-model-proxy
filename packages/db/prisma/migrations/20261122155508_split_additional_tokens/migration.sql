-- wmp:transactional
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- wmp:history-capture (records the history table for the commit marker; keep it here)
DO $wmp$ BEGIN PERFORM set_config('wmp.history', coalesce(to_regclass('_prisma_migrations')::oid::text, ''), true); END $wmp$;

-- AlterTable
ALTER TABLE "usage_ledger" ADD COLUMN     "additionalInputTokens" BIGINT;

ALTER TABLE "usage_ledger" ADD COLUMN     "additionalOutputTokens" BIGINT;

-- wmp:commit-marker (lets the runner prove this transaction committed; keep it last)
DO $wmp$ DECLARE history text := current_setting('wmp.history', true); BEGIN IF history <> '' THEN EXECUTE format('UPDATE %s SET "logs" = %L WHERE "id" = (SELECT "id" FROM %s WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL ORDER BY "started_at" DESC LIMIT 1)', history::oid::regclass, 'wmp:committed', history::oid::regclass); END IF; END $wmp$;
COMMIT;
