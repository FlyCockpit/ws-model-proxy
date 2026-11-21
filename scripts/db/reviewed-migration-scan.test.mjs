import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("CI exempts only reviewed migration.sql and contract.sql inside migration folders", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/pr-checks.yml", import.meta.url),
    "utf8",
  );
  const pattern = workflow.match(/grep -vE '(\^packages\/db\/prisma\/migrations\/[^']+)'/);
  assert.ok(pattern, "the destructive scan must have a migration-file exemption");
  const exempt = new RegExp(pattern[1]);
  for (const name of ["0_init", "20261112000000_upgrade_to_1_0_0"])
    for (const file of ["migration.sql", "contract.sql"])
      assert.equal(exempt.test(`packages/db/prisma/migrations/${name}/${file}:12:SQL`), true);
  for (const file of [
    "packages/db/prisma/schema-hardening.sql",
    "packages/db/prisma/migrations/other.sql",
    "packages/db/prisma/migrations/x/unreviewed.sql",
    "packages/db/prisma/migrations/x/nested/migration.sql",
    "packages/db/prisma/migrations/x/migration.sql.extra",
    "scripts/db/migration.sql",
  ])
    assert.equal(exempt.test(`${file}:12:SQL`), false, file);
  assert.match(workflow, /run: pnpm db:check-migrations/);
  assert.match(workflow, /run: pnpm db:test-adopt-released/);
});
