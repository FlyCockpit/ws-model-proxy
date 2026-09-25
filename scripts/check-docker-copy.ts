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
 * The invariants it enforces (see AGENTS.md § Dockerfiles — keep server and
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
 * closure. Runtime files invoked by the entrypoint are checked separately.
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

// A follower may wait up to the entrypoint's advisory-lock timeout before the
// schema leader's `prisma db push` and hardening run. Reserve additional time
// for that bounded apply phase and application boot before failed health
// probes count toward an unhealthy rollout: push-schema.mjs retries lock
// conflicts for at most ~90s (8 attempts, 5s lock_timeout, <=8s backoff),
// apply-schema-hardening.mjs for at most 60s, plus the runs and boot.
const SCHEMA_APPLY_AND_BOOT_SLACK_SECONDS = 170;

// Runtime artifacts invoked by the production entrypoint. Unlike workspace
// manifests, these are deliberately copied one-by-one into the minimal runner
// image, so guard them explicitly against Dockerfile drift.
const REQUIRED_RUNNER_COPIES = [
  {
    source: "/app/packages/db/scripts/apply-schema-hardening.mjs",
    destination: "./packages/db/scripts/apply-schema-hardening.mjs",
  },
  {
    source: "/app/packages/db/scripts/push-schema.mjs",
    destination: "./packages/db/scripts/push-schema.mjs",
  },
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

/**
 * Parse the entrypoint's bounded Postgres advisory-lock wait. This is sourced
 * from the actual command rather than duplicated, so extending the wait cannot
 * silently leave the health-check budget too short.
 */
function schemaLockTimeoutSeconds(text: string): number | null {
  const seconds = text.match(/SET\s+lock_timeout\s*=\s*'(\d+)s'/i)?.[1];
  return seconds === undefined ? null : Number(seconds);
}

function healthcheckSchemaBudgetErrors(
  dockerfile: string,
  text: string,
  schemaLockTimeoutSeconds: number,
): string[] {
  const startPeriod = healthcheckStartPeriodSeconds(text);
  if (startPeriod === null) {
    return [
      `${dockerfile}: missing HEALTHCHECK --start-period=<N>s; the schema-sync startup budget cannot be verified.`,
    ];
  }
  const required = schemaLockTimeoutSeconds + SCHEMA_APPLY_AND_BOOT_SLACK_SECONDS;
  if (startPeriod > required) return [];
  return [
    `${dockerfile}: HEALTHCHECK --start-period=${startPeriod}s must exceed the schema startup budget ` +
      `(${schemaLockTimeoutSeconds}s advisory-lock wait + ${SCHEMA_APPLY_AND_BOOT_SLACK_SECONDS}s apply/boot slack = ${required}s).`,
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
  return [...found];
}

type RunnerCopy = { source: string; destination: string };

/** `COPY [--flags] --from=builder <source> <destination>` lines of the runner stage. */
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
    if (fields[0]?.toUpperCase() !== "COPY" || !fields.includes("--from=builder")) continue;
    const source = fields.at(-2);
    const destination = fields.at(-1);
    if (source && destination) copies.push({ source, destination });
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
  // Regression fixture: the pass-8 image copied push-schema.mjs without the
  // helper it imports. The closure check must report it.
  const files: Record<string, string> = {
    "packages/db/scripts/push-schema.mjs": `import { a } from "./helper.mjs";\nconst x = await import("./lazy.mjs");\nconst root = new URL("..", import.meta.url);\nconst sql = new URL("../prisma/x.sql", import.meta.url);`,
    "packages/db/scripts/helper.mjs": `export { b } from "./nested.mjs";`,
    "packages/db/scripts/lazy.mjs": "",
    "packages/db/scripts/nested.mjs": "",
  };
  const fixture = `FROM node AS runner
COPY --from=builder /app/packages/db/prisma ./packages/db/prisma
COPY --from=builder /app/packages/db/scripts/push-schema.mjs ./packages/db/scripts/push-schema.mjs
COPY --from=builder /app/packages/db/scripts/lazy.mjs ./packages/db/scripts/lazy.mjs
`;
  const result = missingRuntimeReferences(
    ["/app/packages/db/scripts/push-schema.mjs"],
    runnerBuilderCopies(fixture),
    (path) => files[path] ?? null,
    (path) => path === "packages/db",
  );
  deepStrictEqual(result.sort(), [
    "/app/packages/db/scripts/helper.mjs (referenced by /app/packages/db/scripts/push-schema.mjs)",
    "/app/packages/db/scripts/nested.mjs (referenced by /app/packages/db/scripts/helper.mjs)",
  ]);
}

if (process.argv.includes("--self-test")) {
  const healthcheckFixture = (startPeriod: number) => `FROM base AS runner
HEALTHCHECK --interval=30s --timeout=5s --start-period=${startPeriod}s \\
  CMD node -e "process.exit(0)"
`;
  deepStrictEqual(schemaLockTimeoutSeconds("SET lock_timeout = '300s';"), 300);
  deepStrictEqual(healthcheckSchemaBudgetErrors("Dockerfile", healthcheckFixture(480), 300), []);
  deepStrictEqual(healthcheckSchemaBudgetErrors("Dockerfile", healthcheckFixture(470), 300), [
    "Dockerfile: HEALTHCHECK --start-period=470s must exceed the schema startup budget (300s advisory-lock wait + 170s apply/boot slack = 470s).",
  ]);
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

// The application CMD does not exist until docker-entrypoint.sh has acquired
// the schema lock and, when requested, completed Prisma plus hardening. Docker
// counts failed health probes after --start-period, so keep that period beyond
// the entrypoint's own lock wait and the reserved apply/boot window.
const schemaLockTimeout = schemaLockTimeoutSeconds(
  readFileSync(resolve(ROOT, "scripts/docker-entrypoint.sh"), "utf8"),
);
if (schemaLockTimeout === null) {
  errors.push(
    "scripts/docker-entrypoint.sh: cannot parse the schema advisory lock timeout — update schemaLockTimeoutSeconds() to match the source shape.",
  );
} else {
  for (const dockerfile of DOCKERFILES) {
    errors.push(
      ...healthcheckSchemaBudgetErrors(
        dockerfile,
        readFileSync(resolve(ROOT, dockerfile), "utf8"),
        schemaLockTimeout,
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

  for (const required of REQUIRED_RUNNER_COPIES) {
    let currentStage = "";
    const found = [...logicalLines(dockerfileText)].some(({ line }) => {
      const stageMatch = /^FROM\s+(?:--\S+\s+)*\S+\s+AS\s+(\S+)/i.exec(line);
      if (stageMatch) {
        currentStage = stageMatch[1] ?? "";
        return false;
      }
      const fields = line.split(/\s+/);
      return (
        currentStage === RUNNER &&
        fields[0]?.toUpperCase() === "COPY" &&
        fields.at(-2) === required.source &&
        fields.at(-1) === required.destination
      );
    });
    if (!found) {
      errors.push(
        `${dockerfile}: missing runtime COPY for "${required.source}" to "${required.destination}".`,
      );
    }
  }

  // Runtime scripts reach other files through relative imports and
  // `new URL(..., import.meta.url)`; the runner copies files one by one, so
  // every file in that closure must be copied to the same path.
  for (const reference of missingRuntimeReferences(
    REQUIRED_RUNNER_COPIES.map((required) => required.source),
    runnerBuilderCopies(dockerfileText),
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
