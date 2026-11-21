// Pure parts of generate-initial-migrations.mjs (no git, no Prisma).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  hardeningBody,
  initSql,
  readSection,
  section,
  upgradeHardening,
  upgradeSql,
} from "./generate-initial-migrations.mjs";
import { checkWrapper, unwrapBody } from "./lib/sql.mjs";

describe("generate-initial-migrations", () => {
  test("hardeningBody strips the outer transaction and refuses nested ones", () => {
    assert.equal(hardeningBody("-- c\nBEGIN;\nSELECT 1;\nCOMMIT;\n"), "SELECT 1;");
    assert.throws(() => hardeningBody("SELECT 1;"), /wrapped in BEGIN/);
    assert.throws(() => hardeningBody("SELECT 0;\nBEGIN;\nSELECT 1;\nCOMMIT;"), /outside/);
    assert.throws(
      () => hardeningBody("BEGIN;\nSELECT 1;\nCOMMIT;\nSELECT 2;\nCOMMIT;"),
      /transaction statement: COMMIT;/,
    );
    // PL/pgSQL BEGIN has no semicolon and stays.
    assert.match(hardeningBody("BEGIN;\nDO $x$ BEGIN\nNULL;\nEND $x$;\nCOMMIT;"), /DO \$x\$ BEGIN/);
  });

  test("sections round-trip", () => {
    const text = `x\n${section("hardening", "  SELECT 1;\n")}\ny`;
    assert.equal(readSection(text, "hardening"), "SELECT 1;");
    assert.throws(() => readSection(text, "other"), /missing or ambiguous/);
  });

  test("the upgrade retries its NOWAIT lock in subtransactions", () => {
    const out = upgradeHardening(
      'SELECT 1;\nLOCK TABLE "user",\n  node IN ACCESS EXCLUSIVE MODE NOWAIT;\nSELECT 2;',
    );
    assert.match(out, /^SELECT 1;\nDO \$wmp_lock\$/);
    assert.match(
      out,
      /BEGIN\n {6}LOCK TABLE "user",\n {8}node IN ACCESS EXCLUSIVE MODE NOWAIT;\n {6}EXIT;/,
    );
    assert.match(out, /EXCEPTION WHEN lock_not_available THEN/);
    assert.match(out, /\$wmp_lock\$;\nSELECT 2;$/);
    assert.throws(() => upgradeHardening("SELECT 1;"), /exactly one/);
    assert.throws(
      () =>
        upgradeHardening(
          "LOCK TABLE a IN ACCESS EXCLUSIVE MODE NOWAIT;\nLOCK TABLE b IN ACCESS EXCLUSIVE MODE NOWAIT;",
        ),
      /exactly one/,
    );
  });

  test("both files carry an intact transactional wrapper", () => {
    for (const sql of [
      initSql("CREATE TABLE a (id int);", "SELECT 1;"),
      upgradeSql("", "SELECT 2;"),
    ]) {
      assert.equal(checkWrapper(sql).ok, true, checkWrapper(sql).reason);
      assert.ok(unwrapBody(sql).includes("-- section"));
    }
    assert.match(
      upgradeSql("", "SELECT 2;"),
      /DROP FUNCTION IF EXISTS wmp_schema_hardening_state\(\);/,
    );
  });
});
