/**
 * Guards the hand-enumerated `COPY <app-or-package>/package.json` lists in the
 * two Dockerfiles against the actual set of workspace members on disk.
 *
 *   pnpm docker:check-copy   — verify without writing (CI gate; non-zero exit on drift)
 *
 * Why this exists: `Dockerfile` and `Dockerfile.worker` copy each workspace
 * member's `package.json` individually BEFORE `pnpm install --frozen-lockfile`
 * (so workspace symlinks + the lockfile's importers resolve) and BEFORE
 * `COPY . .`. Add a new `packages/*` or `apps/*` workspace member and forget to
 * add its COPY line and the install step fails inside `docker build` — a failure
 * that never shows up in `pnpm build`, tests, or typecheck. This script makes
 * that omission a fast, CI-visible error instead.
 *
 * The invariants it enforces (see AGENTS.md, Core Rules — keep server and
 * worker in sync):
 *
 *   1. Each `builder` stage installs the whole workspace (`pnpm install
 *      --frozen-lockfile`, no filter), so it MUST list every on-disk workspace
 *      member except the intentional exclusions below — and both Dockerfiles'
 *      builder lists must therefore be identical.
 *   2. Each `prod-deps` stage installs a filtered subset (`--filter=web...` /
 *      `--filter=worker...`), so its list must be a NON-EMPTY SUBSET of the same
 *      file's builder list — never referencing a member the builder omits or one
 *      that no longer exists on disk. Non-empty because a subset check alone is
 *      satisfied by the empty set: deleting every COPY line would otherwise read
 *      as "in sync".
 *   3. Within a stage, every COPY line must appear BEFORE that stage's
 *      `pnpm install`. This is the ordering the whole scheme depends on, so it
 *      is checked rather than assumed — a COPY that drifts below the install
 *      breaks `docker build` and passes every other check in CI.
 *
 * What it still cannot tell you: whether `prod-deps` is missing a member the
 * image needs at RUNTIME. Which members belong there is a judgment call per
 * image (see AGENTS.md), so adding that line when you add a workspace member
 * remains a manual step.
 *
 * Intentional exclusions (allowlisted, never expected in a COPY list):
 *   - apps/cli    — excluded from the Docker build context via .dockerignore
 *                   (the Rust CLI never ships in the container images).
 *   - apps/native — the Expo app enters the builder only via `COPY . .`; it is
 *                   never installed ahead of time and never reaches a runner.
 *
 * Runner workspace manifests are deliberately not checked as an install
 * closure. Runtime files invoked by the entrypoint (the migration runner and
 * the backup/restore commands) are checked separately: each is copied to the
 * same path, with every file it reaches. The HEALTHCHECK `--start-period` is
 * checked against the migration startup gate parsed from the runner's source.
 *
 * Dependency-free by design (node:fs only) — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { deepStrictEqual } from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
// apps/cli is the Rust CLI and is excluded from the Docker context via .dockerignore.
const ALLOWLIST = new Set(["apps/cli"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";
const RUNNER = "runner";

// Single production image — no worker Dockerfile in this repo.
const DOCKERFILES = ["Dockerfile"];

// The HEALTHCHECK start-period must fund the whole migration gate in front of
// the CMD: the runner's fixed wait (connection retries plus the runner lock, or
// a follower's wait), the leader's own apply (the optional backup plus `prisma
// migrate deploy`: APPLY_BUDGET_SLACK), and every other timed step of a start,
// parsed from the runner's source (BUDGET_SOURCES): the one-time 0.4.3
// adoption, the pre-deploy catalog read, the scheduled deletions run budget
// plus the bookkeeping that may run past it, the image-schema diff, the
// deletions' catalog read, registration, and the runner-table steps
// (RUNTIME_STEPS × RUNTIME_STEP_TIMEOUT_MS):
// 540 > 300 + 120 + 30 + 10 + 30 + 5 + 20 + 5 + 5 + 5 × 2 = 535.
const APPLY_BUDGET_SLACK = 120;
const BUDGET_SOURCES = ["scripts/db/migrate-runtime.mjs", "scripts/db/lib/contracts.mjs"];

// Runtime scripts the production entrypoint invokes. The runner stage copies
// files one by one, so each of these, and every file they reach through
// relative imports or sibling-script calls, must be copied to the same path.
const RUNTIME_ENTRY_SCRIPTS = [
  "/app/scripts/db/migrate-runtime.mjs",
  "/app/scripts/backup/pre-migrate.sh",
  "/app/scripts/backup/restore.sh",
  "/app/scripts/backup/schedule.mjs",
  "/app/scripts/backup/drill.mjs",
  "/app/scripts/backup/host.sh",
];

/** Discover on-disk workspace members: `apps/*` / `packages/*` with a package.json. */
function discoverMembers(): Set<string> {
  const members = new Set<string>();
  for (const group of ["apps", "packages"]) {
    let entries: string[];
    try {
      entries = readdirSync(resolve(ROOT, group), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }
    for (const name of entries) {
      const id = `${group}/${name}`;
      try {
        readFileSync(resolve(ROOT, group, name, "package.json"));
        members.add(id);
      } catch {
        // no package.json → not a workspace member (e.g. an assets-only dir)
      }
    }
  }
  return members;
}

/**
 * Yield Dockerfile *logical* lines: physical lines with trailing-backslash
 * continuations folded into one, reported at the line number the instruction
 * starts on. Without this, any multi-line `RUN`/`COPY` reads as several
 * unrelated fragments — see `installRe` for why that matters.
 */
function* logicalLines(text: string): Generator<{ line: string; lineNo: number }> {
  const physical = text.split("\n");
  let buffer = "";
  let startLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = (physical[i] ?? "").trim();
    // A `\` continues the instruction onto the next physical line.
    const continues = raw.endsWith("\\");
    const piece = continues ? raw.slice(0, -1).trim() : raw;

    if (buffer === "") startLine = i + 1;
    buffer = buffer === "" ? piece : `${buffer} ${piece}`;

    if (continues) continue;
    yield { line: buffer, lineNo: startLine };
    buffer = "";
  }
  // A file ending on a dangling continuation still yields what it accumulated.
  if (buffer !== "") yield { line: buffer, lineNo: startLine };
}

/** Return a HEALTHCHECK start-period in seconds, or null when it is absent. */
function healthcheckStartPeriodSeconds(text: string): number | null {
  for (const { line } of logicalLines(text)) {
    if (!/^HEALTHCHECK\s/i.test(line)) continue;
    const seconds = line.match(/--start-period=(\d+)s/i)?.[1];
    return seconds === undefined ? null : Number(seconds);
  }
  return null;
}

/** `export const <NAME> = <number>;` from the runner's source. */
function exportedNumber(text: string, name: string): number | null {
  const value = text.match(new RegExp(`export const ${name}\\s*=\\s*([\\d_]+)`))?.[1];
  return value ? Number(value.replaceAll("_", "")) : null;
}

/** The startup budget: every timed step of a start, in order, in seconds. */
type StartupBudget = { parts: Array<{ label: string; seconds: number }> };

/** Millisecond constants, each one timed step (label = the constant's name). */
const BUDGET_STEPS = [
  "WAIT_TIMEOUT_MS",
  "BASELINE_COMPARE_TIMEOUT_MS",
  "PREDEPLOY_CATALOG_TIMEOUT_MS",
  "CONTRACT_RUN_BUDGET_MS",
  "CONTRACT_PREAMBLE_TIMEOUT_MS",
  "IMAGE_SCHEMA_TIMEOUT_MS",
  "CONTRACTS_CATALOG_TIMEOUT_MS",
  "REGISTER_TIMEOUT_MS",
];

/** Parse the budget from the concatenated BUDGET_SOURCES; null when any part is missing. */
function startupBudget(text: string): StartupBudget | null {
  const parts: StartupBudget["parts"] = [];
  for (const name of BUDGET_STEPS) {
    const ms = exportedNumber(text, name);
    if (ms === null) return null;
    parts.push({ label: name, seconds: ms / 1000 });
    if (name === "WAIT_TIMEOUT_MS")
      parts.push({ label: "apply budget", seconds: APPLY_BUDGET_SLACK });
  }
  const steps = exportedNumber(text, "RUNTIME_STEPS");
  const stepMs = exportedNumber(text, "RUNTIME_STEP_TIMEOUT_MS");
  if (steps === null || stepMs === null) return null;
  parts.push({
    label: `RUNTIME_STEPS ${steps} × RUNTIME_STEP_TIMEOUT_MS`,
    seconds: (steps * stepMs) / 1000,
  });
  return { parts };
}

/**
 * The HEALTHCHECK start-period must EXCEED the migration startup gate: the
 * image sits in the entrypoint's gate before the CMD process exists, and
 * Docker only exempts failed probes during --start-period. Pure for --self-test.
 */
function healthcheckStartPeriodErrors(
  dockerfile: string,
  text: string,
  budget: StartupBudget,
): string[] {
  const startPeriod = healthcheckStartPeriodSeconds(text);
  if (startPeriod === null) {
    return [
      `${dockerfile}: missing HEALTHCHECK --start-period=<N>s; the migration startup budget cannot be verified.`,
    ];
  }
  const required = budget.parts.reduce((sum, part) => sum + part.seconds, 0);
  if (startPeriod > required) return [];
  return [
    `${dockerfile}: HEALTHCHECK --start-period=${startPeriod}s must exceed the migration startup gate: ` +
      `${budget.parts.map((part) => `${part.label} ${part.seconds}s`).join(" + ")} ` +
      `(${BUDGET_SOURCES.join(", ")}) = ${required}s.`,
  ];
}

/**
 * Relative module and file references of a runtime script: static
 * `import`/`export ... from`, dynamic `import()`, and
 * `new URL(<relative>, import.meta.url)`. Only `./` and `../` specifiers;
 * bare package names resolve from the COPY'd node_modules.
 */
export function relativeReferences(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']*|\.{1,2})["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']*)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g,
    /\bnew\s+URL\(\s*["'](\.{1,2}(?:\/[^"']*)?)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) if (match[1]) found.add(match[1]);
  // Shell siblings: "$HERE/x.mjs" and "$(cd "$(dirname "$0")" && pwd)/x.mjs".
  for (const match of source.matchAll(
    /(?:\$HERE|\$\{HERE\}|&& pwd\))\/([A-Za-z0-9._-]+\.(?:mjs|sh))/g,
  ))
    if (match[1]) found.add(`./${match[1]}`);
  return [...found];
}

type RunnerCopy = { source: string; destination: string };

/**
 * The runner stage's COPY lines, as `/app/<path>` sources and `./<path>`
 * destinations: `COPY [--flags] --from=builder <source> <destination>`, and
 * build-context copies (`COPY a b ./dir/`), where every source lands at
 * `<dir>/<basename>`.
 */
export function runnerBuilderCopies(dockerfileText: string): RunnerCopy[] {
  const copies: RunnerCopy[] = [];
  let currentStage = "";
  for (const { line } of logicalLines(dockerfileText)) {
    const stageMatch = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i.exec(line);
    if (stageMatch) {
      currentStage = stageMatch[1] ?? "";
      continue;
    }
    if (currentStage !== RUNNER) continue;
    const fields = line.split(/\s+/);
    if (fields[0]?.toUpperCase() !== "COPY") continue;
    if (fields.includes("--from=builder")) {
      const source = fields.at(-2);
      const destination = fields.at(-1);
      if (source && destination) copies.push({ source, destination });
      continue;
    }
    if (fields.some((field) => field.startsWith("--from="))) continue;
    const operands = fields.slice(1).filter((field) => !field.startsWith("--"));
    const destination = operands.pop();
    if (!destination?.startsWith("./")) continue;
    for (const source of operands) {
      const target =
        operands.length > 1 || destination.endsWith("/")
          ? posix.join(destination, posix.basename(source))
          : destination;
      copies.push({ source: `/app/${source}`, destination: `./${posix.normalize(target)}` });
    }
  }
  return copies;
}

/** The runner copy that places `/app/<path>` at the same path in the image, if any. */
function coveringCopy(copies: RunnerCopy[], appPath: string): RunnerCopy | undefined {
  return copies.find(
    ({ source, destination }) =>
      (appPath === source || appPath.startsWith(`${source}/`)) &&
      destination === `.${source.slice("/app".length)}`,
  );
}

/**
 * Every file a runtime script reaches through relative references (followed
 * through imported .mjs/.js modules) that the runner stage does not COPY to
 * the same path. `read` returns a repo file's text, `isDirectory` whether a
 * repo path is a directory (a directory reference, e.g. a package root used
 * as a cwd, is not a file the image must contain).
 */
export function missingRuntimeReferences(
  entries: readonly string[],
  copies: RunnerCopy[],
  read: (repoPath: string) => string | null,
  isDirectory: (repoPath: string) => boolean,
): string[] {
  const missing = new Set<string>();
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const appPath = queue.shift() ?? "";
    if (seen.has(appPath)) continue;
    seen.add(appPath);
    const repoPath = appPath.slice("/app/".length);
    const text = read(repoPath);
    if (text === null) continue;
    for (const reference of relativeReferences(text)) {
      const target = posix.normalize(posix.join(posix.dirname(appPath), reference));
      if (isDirectory(target.slice("/app/".length))) continue;
      if (!coveringCopy(copies, target)) missing.add(`${target} (referenced by ${appPath})`);
      if (/\.(?:mjs|js)$/.test(target)) queue.push(target);
    }
  }
  return [...missing];
}

{
  // Regression fixture: an image that copies a runtime script without a
  // module it imports. The closure check must report it.
  const files: Record<string, string> = {
    "scripts/db/migrate-runtime.mjs": `import { a } from "./lib/helper.mjs";\nconst x = await import("./lazy.mjs");\nconst root = new URL("..", import.meta.url);`,
    "scripts/db/lib/helper.mjs": `export { b } from "./nested.mjs";`,
    "scripts/db/lazy.mjs": "",
    "scripts/db/lib/nested.mjs": "",
    "scripts/backup/pre-migrate.sh": `HERE="$(cd "$(dirname "$0")" && pwd)"\nnode "$HERE/lib.mjs" pg-env\nnode "$HERE/s3.mjs" upload`,
    "scripts/backup/lib.mjs": "",
  };
  const fixture = `FROM node AS runner
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY scripts/db/migrate-runtime.mjs scripts/db/lazy.mjs ./scripts/db/
COPY scripts/backup/pre-migrate.sh \\
     scripts/backup/lib.mjs \\
     ./scripts/backup/
`;
  const result = missingRuntimeReferences(
    ["/app/scripts/db/migrate-runtime.mjs", "/app/scripts/backup/pre-migrate.sh"],
    runnerBuilderCopies(fixture),
    (path) => files[path] ?? null,
    (path) => path === "scripts" || path === "scripts/db",
  );
  deepStrictEqual(result.sort(), [
    "/app/scripts/backup/s3.mjs (referenced by /app/scripts/backup/pre-migrate.sh)",
    "/app/scripts/db/lib/helper.mjs (referenced by /app/scripts/db/migrate-runtime.mjs)",
    "/app/scripts/db/lib/nested.mjs (referenced by /app/scripts/db/lib/helper.mjs)",
  ]);
}

if (process.argv.includes("--self-test")) {
  const healthcheckFixture = (startPeriod: number) => `FROM base AS runner
HEALTHCHECK --interval=30s --timeout=5s --start-period=${startPeriod}s \\
  CMD node -e "process.exit(0)"
`;
  const budget = startupBudget(
    "export const WAIT_TIMEOUT_MS = 300_000;\nexport const BASELINE_COMPARE_TIMEOUT_MS = 30_000;\n" +
      "export const PREDEPLOY_CATALOG_TIMEOUT_MS = 10_000;\nexport const CONTRACT_RUN_BUDGET_MS = 30_000;\n" +
      "export const CONTRACT_PREAMBLE_TIMEOUT_MS = 5_000;\nexport const IMAGE_SCHEMA_TIMEOUT_MS = 20_000;\n" +
      "export const CONTRACTS_CATALOG_TIMEOUT_MS = 5_000;\nexport const REGISTER_TIMEOUT_MS = 5_000;\n" +
      "export const RUNTIME_STEPS = 5;\nexport const RUNTIME_STEP_TIMEOUT_MS = 2_000;\n",
  );
  if (!budget) throw new Error("startupBudget did not parse the fixture");
  deepStrictEqual(healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(540), budget), []);
  deepStrictEqual(
    healthcheckStartPeriodErrors("Dockerfile", healthcheckFixture(535), budget).length,
    1,
  );
  deepStrictEqual(startupBudget("export const WAIT_TIMEOUT_MS = 300_000;"), null);
  console.log("Docker runtime regression checks passed.");
  process.exit(0);
}

/**
 * Split a Dockerfile into stages keyed by their `AS <name>` label and collect
 * the `COPY <group>/<name>/package.json <group>/<name>/` members in each.
 */
function parseStages(dockerfile: string): Map<string, Set<string>> {
  const text = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = new Map<string, Set<string>>();
  let current: Set<string> | null = null;

  // `FROM --platform=… <image> AS <stage>`: the flags between FROM and the
  // image are optional, and `AS` is case-insensitive in Dockerfile syntax.
  const stageRe = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i;
  const copyRe =
    /^COPY\s+((?:apps|packages)\/[^/]+)\/package\.json\s+((?:apps|packages)\/[^/]+)\//i;
  // The whole point of the hand-enumerated COPY lines is that they land before
  // the install, so the lockfile's importers and workspace symlinks resolve
  // against real package.json files. A COPY that drifts below this breaks
  // `docker build` at install time and nothing else in CI would catch it.
  //
  // Matched against JOINED logical lines (see below), not physical ones. The
  // install is single-line today, but the standard BuildKit cache-mount form
  // splits it:
  //
  //     RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  //         pnpm install --frozen-lockfile
  //
  // A physical-line match would silently stop finding the install there, and
  // invariant 3 would check nothing while still reporting "in sync" — the exact
  // vacuous pass the other two invariants guard against.
  const installRe = /^RUN\s[\s\S]*pnpm\s+install/i;

  let currentStage = "";
  let installSeenAt = -1;

  for (const { line, lineNo } of logicalLines(text)) {
    const stageMatch = stageRe.exec(line);
    if (stageMatch) {
      current = new Set<string>();
      currentStage = stageMatch[1] ?? "";
      installSeenAt = -1;
      stages.set(currentStage, current);
      continue;
    }
    if (!current) continue;
    if (installRe.test(line)) {
      installSeenAt = lineNo;
      continue;
    }
    const copyMatch = copyRe.exec(line);
    if (copyMatch) {
      if (installSeenAt !== -1) {
        errors.push(
          `${dockerfile} (${currentStage}): COPY line for "${copyMatch[1]}" on line ${lineNo} ` +
            `comes AFTER \`pnpm install\` on line ${installSeenAt}. It must precede the install, ` +
            `or the install resolves against a missing package.json and \`docker build\` fails.`,
        );
      }
      // Both sides of the COPY must reference the same member; a mismatch is a
      // typo worth surfacing (e.g. a bad copy/paste of the destination path).
      if (copyMatch[1] !== copyMatch[2]) {
        errors.push(
          `${dockerfile}: COPY line mismatch — source "${copyMatch[1]}" but destination "${copyMatch[2]}".`,
        );
      }
      current.add(copyMatch[1] ?? "");
    }
  }
  return stages;
}

const errors: string[] = [];

// The application CMD does not exist until docker-entrypoint.sh has run the
// migration runner. Docker counts failed health probes after --start-period,
// so that period must exceed every timed step of the gate.
const budget = startupBudget(
  BUDGET_SOURCES.map((source) => readFileSync(resolve(ROOT, source), "utf8")).join("\n"),
);
if (budget === null) {
  errors.push(
    `${BUDGET_SOURCES.join(", ")}: cannot parse the startup budget constants (${BUDGET_STEPS.join(", ")}, RUNTIME_STEPS, RUNTIME_STEP_TIMEOUT_MS) — update startupBudget() to match the source.`,
  );
} else {
  for (const dockerfile of DOCKERFILES) {
    errors.push(
      ...healthcheckStartPeriodErrors(
        dockerfile,
        readFileSync(resolve(ROOT, dockerfile), "utf8"),
        budget,
      ),
    );
  }
}

const members = discoverMembers();
const expectedBuilder = new Set([...members].filter((m) => !ALLOWLIST.has(m)).sort());

const builderLists = new Map<string, Set<string>>();

for (const dockerfile of DOCKERFILES) {
  const dockerfileText = readFileSync(resolve(ROOT, dockerfile), "utf8");
  const stages = parseStages(dockerfile);

  const runnerCopies = runnerBuilderCopies(dockerfileText);
  for (const entry of RUNTIME_ENTRY_SCRIPTS) {
    if (!coveringCopy(runnerCopies, entry))
      errors.push(`${dockerfile} (${RUNNER}): missing runtime COPY for "${entry}" (same path).`);
  }

  // Runtime scripts reach other files through relative imports and
  // `new URL(..., import.meta.url)`; the runner copies files one by one, so
  // every file in that closure must be copied to the same path.
  for (const reference of missingRuntimeReferences(
    RUNTIME_ENTRY_SCRIPTS,
    runnerCopies,
    (repoPath) => {
      const path = resolve(ROOT, repoPath);
      return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null;
    },
    (repoPath) => {
      const path = resolve(ROOT, repoPath);
      return existsSync(path) && statSync(path).isDirectory();
    },
  )) {
    errors.push(`${dockerfile} (${RUNNER}): runtime script reference not copied: ${reference}.`);
  }

  const builder = stages.get(BUILDER);
  if (!builder) {
    errors.push(
      `${dockerfile}: no \`${BUILDER}\` stage found (expected a \`FROM … AS ${BUILDER}\`).`,
    );
  } else {
    builderLists.set(dockerfile, builder);
    // Invariant 1: builder must list every on-disk member minus the allowlist.
    const missing = [...expectedBuilder].filter((m) => !builder.has(m));
    const extra = [...builder].filter((m) => !members.has(m) || ALLOWLIST.has(m));
    for (const m of missing) {
      errors.push(
        `${dockerfile} (${BUILDER}): missing COPY line for "${m}". Add:\n    COPY ${m}/package.json ${m}/`,
      );
    }
    for (const m of extra) {
      const why = ALLOWLIST.has(m)
        ? "it is an intentional exclusion (allowlisted)"
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${BUILDER}): unexpected COPY line for "${m}" — ${why}.`);
    }
  }

  const prodDeps = stages.get(PROD_DEPS);
  if (!prodDeps) {
    errors.push(
      `${dockerfile}: no \`${PROD_DEPS}\` stage found (expected a \`FROM … AS ${PROD_DEPS}\`).`,
    );
  } else if (builder) {
    // Invariant 2: prod-deps must be a non-empty subset of this file's builder
    // list. Subset-checking alone passes vacuously on an empty set, so wiping
    // every COPY line would read as "in sync" — assert it kept some.
    if (prodDeps.size === 0) {
      errors.push(
        `${dockerfile} (${PROD_DEPS}): no workspace COPY lines found. This stage must copy the ` +
          `package.json of every member the image needs at runtime; an empty list passes the ` +
          `subset check vacuously but fails \`docker build\`.`,
      );
    }
    const notInBuilder = [...prodDeps].filter((m) => !builder.has(m));
    for (const m of notInBuilder) {
      const why = members.has(m)
        ? `it is absent from the ${BUILDER} stage (the two lists drifted)`
        : "no such workspace member exists on disk (stale line?)";
      errors.push(`${dockerfile} (${PROD_DEPS}): COPY line for "${m}" — ${why}.`);
    }
  }
}

// Invariant 1 (corollary): when multiple Dockerfiles exist, their builder lists
// must match. With a single production image this is a no-op.
if (DOCKERFILES.length >= 2 && builderLists.size === DOCKERFILES.length) {
  const [a, b] = DOCKERFILES as [string, string];
  const setA = builderLists.get(a)!;
  const setB = builderLists.get(b)!;
  const onlyA = [...setA].filter((m) => !setB.has(m));
  const onlyB = [...setB].filter((m) => !setA.has(m));
  for (const m of onlyA) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${a} but not ${b}.`);
  }
  for (const m of onlyB) {
    errors.push(`${BUILDER} stages diverged: "${m}" is in ${b} but not ${a}.`);
  }
}

if (errors.length > 0) {
  console.error("Dockerfile COPY-list drift detected:\n");
  for (const e of errors) console.error(`  • ${e}`);
  console.error(
    "\nEdit the COPY lists in the builder/prod-deps stages of the Dockerfile(s) to match the workspace,",
  );
  console.error(
    "or update the ALLOWLIST in scripts/check-docker-copy.ts if an exclusion is genuinely intentional.",
  );
  process.exit(1);
}

// Report only the allowlist entries that still exist on disk. Both are
// removable modules (patterns/removable/{cli,native}.md), so naming a directory
// the developer already deleted reads as "this check still expects apps/native
// back" — the opposite of the truth.
//
// Tested against the filesystem, not `members`: apps/cli is a cargo workspace
// with no package.json, so it is deliberately never a discovered member even
// though it is very much present.
const excluded = [...ALLOWLIST].filter((member) => existsSync(resolve(ROOT, member))).sort();

console.log(
  `Dockerfile COPY lists are in sync with ${members.size} workspace members` +
    (excluded.length > 0
      ? ` (${excluded.length} intentionally excluded: ${excluded.join(", ")}).`
      : "."),
);
