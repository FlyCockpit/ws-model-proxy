// Runs scripts/test-docker-entrypoint-schema.sh for `db:validate`. That test drives the Linux
// container entrypoint (setsid, psql and sh stubs), so it cannot run on Windows: there it is
// skipped with a note. CI and every Unix machine run it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log(
    "Skipping the Docker entrypoint schema test on Windows (it needs a Linux shell); CI runs it.",
  );
  process.exit(0);
}

const script = fileURLToPath(
  new URL("../../../scripts/test-docker-entrypoint-schema.sh", import.meta.url),
);
const result = spawnSync("sh", [script], { stdio: "inherit" });
process.exit(result.status ?? 1);
