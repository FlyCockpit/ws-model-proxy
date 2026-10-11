#!/bin/sh
# PostgreSQL integration suites (part of the preview gate): pushes the schema and the
# hardening into SCHEMA_VALIDATION_DATABASE_URL (a disposable database), then runs every
# `*.postgres.integration.test.ts` / `*.integration.test.ts` suite of the API and the server
# against it. The database is changed in place: never point this at real data.
set -eu
: "${SCHEMA_VALIDATION_DATABASE_URL:?set SCHEMA_VALIDATION_DATABASE_URL to a disposable database}"
export REQUIRE_POSTGRES_INTEGRATION=1
DATABASE_URL="$SCHEMA_VALIDATION_DATABASE_URL" pnpm --filter @ws-model-proxy/db db:push
pnpm --filter @ws-model-proxy/api test:postgres
pnpm --filter server test:postgres
