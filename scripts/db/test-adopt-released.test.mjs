import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("../assert-local-database.sh", import.meta.url));
test("released adoption guard accepts only local routing and has no escape hatch", () => {
  for (const [url, status] of [
    ["postgresql://localhost:6543/postgres", 0],
    ["postgresql://127.0.0.1/postgres?sslmode=disable", 0],
    ["postgresql://[::1]/postgres", 0],
    ["postgresql://db.example.com/postgres", 1],
    ["postgresql://host.docker.internal/postgres", 1],
    ["postgresql://192.168.1.2/postgres", 1],
    ["postgresql://localhost/postgres?host=remote", 1],
    ["postgresql://localhost/postgres?hostaddr=10.0.0.1", 1],
    ["postgresql://localhost/postgres?options=-csearch_path=x", 1],
    ["https://localhost/postgres", 1],
    ["", 1],
  ]) {
    const result = spawnSync("bash", [guard, "db:test-adopt-released"], {
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: url,
        ASSERT_LOCAL_DB_ESCAPE: "I_UNDERSTAND_THIS_CAN_DESTROY_DATA",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, status, url);
    assert.doesNotMatch(result.stderr, /postgresql:\/\//);
  }
});
