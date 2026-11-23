// Pure parts of the 0.4.3 adoption (baseline.mjs). The catalog comparison
// itself runs against the released image in ../test-adopt-released.sh.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BASELINE_MIGRATION,
  compareBaseline,
  describeDifferences,
  diffCatalogs,
  ONE_TIME_MIGRATIONS,
  readSchemaCatalog,
  UPGRADE_MIGRATION,
  upgradeAdmitted,
} from "./baseline.mjs";

describe("baseline", () => {
  test("the upgrade migration sorts right after 0_init and is a valid folder name", () => {
    assert.ok(BASELINE_MIGRATION < UPGRADE_MIGRATION);
    assert.match(UPGRADE_MIGRATION, /^\d{14}_[a-z0-9_]{1,60}$/);
    assert.deepEqual([...ONE_TIME_MIGRATIONS], [BASELINE_MIGRATION, UPGRADE_MIGRATION]);
  });

  test("upgradeAdmitted: only the upgrade, only on an empty or [0_init] history", () => {
    assert.equal(upgradeAdmitted(UPGRADE_MIGRATION, []), true);
    assert.equal(upgradeAdmitted(UPGRADE_MIGRATION, ["0_init"]), true);
    assert.equal(upgradeAdmitted(UPGRADE_MIGRATION, ["0_init", "20261201000000_x"]), false);
    assert.equal(upgradeAdmitted("20261201000000_x", ["0_init"]), false);
    assert.equal(upgradeAdmitted(UPGRADE_MIGRATION, ["20261201000000_x"]), false);
  });

  test("diffCatalogs lists each side's extra rows", () => {
    assert.deepEqual(diffCatalogs(["a", "b"], ["b", "c"]), { missing: ["a"], unexpected: ["c"] });
    assert.deepEqual(diffCatalogs(["a"], ["a"]), { missing: [], unexpected: [] });
  });

  test("describeDifferences caps and shortens what it prints", () => {
    const lines = describeDifferences(
      { missing: Array.from({ length: 30 }, (_, i) => `m${i}`), unexpected: ["x".repeat(300)] },
      25,
    );
    assert.match(lines[0], /missing from the database .* \(30\):/);
    assert.equal(lines.filter((line) => /^ {2}m\d+$/.test(line)).length, 25);
    assert.ok(lines.includes("  … and 5 more"));
    const long = lines.at(-1);
    assert.ok(long.endsWith("...") && long.length <= 222, long);
  });

  test("compareBaseline refuses an unexpected scratch schema name before touching the database", async () => {
    const client = { query: async () => assert.fail("no query expected") };
    await assert.rejects(
      compareBaseline(/** @type {never} */ (client), {
        schema: "public",
        body: "",
        scratchName: "public",
      }),
      /unexpected scratch schema name/,
    );
  });

  test("compareBaseline always rolls back, also when the body fails", async () => {
    const seen = [];
    const client = {
      escapeIdentifier: (name) => `"${name}"`,
      query: async (sql) => {
        seen.push(sql.split("\n")[0].trim());
        if (sql === "BODY") throw new Error("boom");
        return { rows: [] };
      },
    };
    await assert.rejects(
      compareBaseline(/** @type {never} */ (client), {
        schema: "public",
        body: "BODY",
        scratchName: "_wmp_baseline_0123456789abcdef",
      }),
      /boom/,
    );
    assert.equal(seen[0], "BEGIN");
    assert.equal(seen.at(-1), "ROLLBACK");
    assert.ok(seen.includes('CREATE SCHEMA "_wmp_baseline_0123456789abcdef"'));
  });

  // A fake session: the catalog of "public" is the live one; the scratch schema's
  // grows with each body applied to it.
  function fakeSession(live) {
    const seen = [];
    let scratch = [];
    const client = {
      escapeIdentifier: (name) => `"${name}"`,
      query: async (sql, params) => {
        seen.push(sql.split("\n")[0].trim());
        if (sql === "BODY") scratch = ["relation a", "constraint a.old"];
        if (sql === "VARIANT") scratch = ["relation a", "constraint a.new", "column a.extra"];
        if (sql === "OTHER") scratch = [...scratch, "column a.other"];
        if (params)
          return { rows: (params[0] === "public" ? live : scratch).map((item) => ({ item })) };
        return { rows: [] };
      },
    };
    return { client, seen };
  }
  const options = (variants) => ({
    schema: "public",
    body: "BODY",
    scratchName: "_wmp_baseline_0123456789abcdef",
    variants,
  });

  test("compareBaseline: 0_init itself matches before any variant runs", async () => {
    const { client, seen } = fakeSession(["relation a", "constraint a.old"]);
    const result = await compareBaseline(
      /** @type {never} */ (client),
      options([{ label: "dev", sql: "VARIANT" }]),
    );
    assert.deepEqual(result, {
      missing: [],
      unexpected: [],
      liveCount: 2,
      equal: true,
      variant: null,
    });
    assert.ok(!seen.includes("VARIANT"));
    assert.equal(seen.at(-1), "ROLLBACK");
  });

  test("compareBaseline: a variant on top of 0_init matches and is named", async () => {
    const live = ["relation a", "constraint a.new", "column a.extra"];
    const { client, seen } = fakeSession(live);
    const result = await compareBaseline(
      /** @type {never} */ (client),
      options([{ label: "dev", sql: "VARIANT" }]),
    );
    assert.deepEqual(result, {
      missing: [],
      unexpected: [],
      liveCount: 3,
      equal: true,
      variant: "dev",
    });
    // The variant runs in the same scratch schema, after 0_init's body.
    assert.ok(seen.indexOf("VARIANT") > seen.indexOf("BODY"));
    assert.equal(seen.at(-1), "ROLLBACK");
  });

  test("compareBaseline: no match reports the differences from 0_init, not from a variant", async () => {
    const { client, seen } = fakeSession(["relation a", "constraint a.hand-made"]);
    const result = await compareBaseline(
      /** @type {never} */ (client),
      options([
        { label: "dev", sql: "VARIANT" },
        { label: "later", sql: "OTHER" },
      ]),
    );
    assert.deepEqual(result, {
      missing: ["constraint a.old"],
      unexpected: ["constraint a.hand-made"],
      liveCount: 2,
      equal: false,
      variant: null,
    });
    assert.ok(seen.includes("VARIANT") && seen.includes("OTHER"));
    assert.equal(seen.at(-1), "ROLLBACK");
  });
});

test("diffCatalogs tolerates live-only extensions but requires baseline extensions", () => {
  assert.deepEqual(
    diffCatalogs(
      ["relation app"],
      ["relation app", "extension pgcrypto", "extension pg_trgm", "extension pg_stat_statements"],
    ),
    { missing: [], unexpected: [] },
  );
  assert.deepEqual(diffCatalogs(["extension required"], []), {
    missing: ["extension required"],
    unexpected: [],
  });
});

test("catalog excludes extension objects and their relation children in every branch", async () => {
  let query;
  await readSchemaCatalog(
    /** @type {never} */ ({
      escapeIdentifier: (name) => name,
      query: async (sql, params) => {
        if (params) query = sql;
        return { rows: [] };
      },
    }),
    "public",
  );
  assert.match(query, /pg_depend WHERE deptype = 'e'/);
  const branches = query.split("UNION ALL").slice(0, -1);
  assert.equal(branches.length, 10);
  for (const branch of branches)
    assert.match(branch, /NOT EXISTS \(SELECT 1 FROM extension_members/);
  for (const alias of ["c", "tc", "ic", "k", "t", "p", "pol"])
    assert.ok(query.includes(`x.objid = ${alias}.oid`), alias);
});
