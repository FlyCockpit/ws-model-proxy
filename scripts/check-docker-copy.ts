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
 * The runner stages are deliberately NOT checked: they copy only the minimal
 * set of manifests a running image needs, not the install closure.
 *
 * Dependency-free by design (node:fs only) — no new packages, safe to run in the
 * CI `lint` job alongside `pnpm env:check`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// Workspace members that legitimately have no pre-install COPY line.
// apps/cli is the Rust CLI and is excluded from the Docker context via .dockerignore.
const ALLOWLIST = new Set(["apps/cli"]);

// Stages whose COPY lists we verify. The runner stages are intentionally left
// out (they copy only what a running image needs, not the install closure).
const BUILDER = "builder";
const PROD_DEPS = "prod-deps";

// Single production image — no worker Dockerfile in this repo.
const DOCKERFILES = ["Dockerfile"];

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

const members = discoverMembers();
const expectedBuilder = new Set([...members].filter((m) => !ALLOWLIST.has(m)).sort());

const builderLists = new Map<string, Set<string>>();

for (const dockerfile of DOCKERFILES) {
  const stages = parseStages(dockerfile);

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
