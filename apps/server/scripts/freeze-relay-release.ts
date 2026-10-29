/**
 * Freezes what a wsmp release sends and reads, for `src/relay/released-compat.test.ts`:
 * copies `apps/cli/tests/fixtures/relay-3.0/{frames,binary}` to `released/<version>/`, marks the
 * hellos with the release's version, and records the fixed values the server sends
 * (`server-to-node-values.json`). Run it when cutting a release (`apps/cli/docs/releasing.md`):
 *
 *   pnpm --filter server exec tsx scripts/freeze-relay-release.ts 0.4.3
 */
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverToNodeFixedValues } from "../src/relay/fixed-values.js";

const version = process.argv[2];
if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
  console.error("usage: freeze-relay-release.ts <version>, e.g. 0.4.3");
  process.exit(2);
}
const fixtures = fileURLToPath(new URL("../../cli/tests/fixtures/", import.meta.url));
const source = join(fixtures, "relay-3.0");
const target = join(fixtures, "released", version);
if (existsSync(target)) {
  console.error(`${target} exists; a released copy is never rewritten`);
  process.exit(1);
}
for (const dir of ["frames", "binary"])
  cpSync(join(source, dir), join(target, dir), { recursive: true });

// Every released wsmp reports `features.selfUpdate` in its hello and `node.state`: give the
// fixtures that omit it the self-update hello's value.
const sent = join(target, "frames", "node-to-server");
const json = (name: string) => JSON.parse(readFileSync(join(sent, name), "utf8"));
const selfUpdate = json("hello-self-update.json").features.selfUpdate;
for (const name of readdirSync(sent)) {
  if (!name.startsWith("hello") && name !== "node.state.json") continue;
  const frame = json(name);
  if (frame.node) frame.node.version = version;
  frame.features.selfUpdate ??= selfUpdate;
  writeFileSync(join(sent, name), `${JSON.stringify(frame, null, 2)}\n`);
}
writeFileSync(
  join(target, "server-to-node-values.json"),
  `${JSON.stringify(serverToNodeFixedValues(), null, 2)}\n`,
);
console.log(`froze relay fixtures for wsmp ${version} in ${target}`);
