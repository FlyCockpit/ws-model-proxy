/**
 * Regenerates the `.env.example` files from `scripts/lib/env-manifest.ts`, and
 * verifies that the manifest still covers every key declared in the Zod env
 * schemas.
 *
 *   pnpm env:sync    — rewrite the .env.example files
 *   pnpm env:check   — verify without writing (CI gate; non-zero exit on drift)
 *
 * What it catches (patterns/environment-variables.md § The CI gate has the full
 * list): a schema key nobody added to the manifest, a manifest entry naming a
 * key or group that doesn't exist, keys hidden behind a spread, a variable
 * render.yaml never declares, and a stale generated .env.example.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  DEPLOY_TARGETS,
  ENV_GROUPS,
  ENV_VARS,
  type EnvFile,
  type EnvVar,
  groupsForFile,
  varsInGroup,
} from "./lib/env-manifest.js";
import { scanSchemaKeys } from "./lib/env-schema.js";

const ROOT = resolve(import.meta.dirname!, "..");
const CHECK = process.argv.includes("--check");

// ---------------------------------------------------------------------------
// Where each file lives, and its header prose
// ---------------------------------------------------------------------------

interface FileSpec {
  file: EnvFile;
  path: string;
  header: string[];
}

const GENERATED_BANNER = [
  "GENERATED FROM scripts/lib/env-manifest.ts — DO NOT EDIT BY HAND.",
  "Add or change a variable in that manifest, then run `pnpm env:sync`.",
];

const FILES: FileSpec[] = [
  {
    file: "root",
    path: ".env.example",
    header: [
      ...GENERATED_BANNER,
      "",
      "This is the single canonical .env location — loaded by every package.",
      "Copy to .env and fill in real values: cp .env.example .env",
      "Do NOT create per-app .env files (e.g. apps/server/.env).",
      "",
      "For a PRODUCTION environment, don't fill this in by hand — run",
      "`pnpm generate:secrets`. It generates the random values, prompts only for",
      "what it can't know, skips whatever your deploy platform injects, and",
      "validates the result before printing it.",
      "",
      "Email is optional: without SMTP, email/password auth works and",
      "verification is not required. With SMTP set, verification is required",
      "and verification/reset/2FA mail is sent.",
    ],
  },
  {
    file: "web",
    path: "apps/web/.env.example",
    header: [...GENERATED_BANNER],
  },
];

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function commentBlock(lines: string[]): string[] {
  return lines.map((line) => (line ? `# ${line}` : "#"));
}

function renderVar(v: EnvVar, groupIsOptional: boolean): string[] {
  const out: string[] = [];

  // `comment` is the var's prose block. `hint` is the one-liner the interactive
  // generator prints under its prompt — without this fallback that guidance
  // ("required when TRANSLATION_PROVIDER=openrouter", "auto for R2") existed
  // only inside `generate:secrets` and silently vanished from .env.example.
  if (v.comment) out.push(...commentBlock(v.comment));
  else if (v.hint) out.push(...commentBlock([v.hint]));

  if (v.choices) {
    out.push(...commentBlock([`Allowed: ${v.choices.map((c) => c.value).join(" | ")}`]));
  }

  // `generate` vars are emitted live but empty — the value is per-environment
  // and must never be committed, so an empty assignment is the honest form.
  // Inside an optional group they stay commented like everything else, so that
  // uncommenting the block is what turns the feature on.
  if (v.source === "generate") {
    out.push(groupIsOptional ? `# ${v.key}=` : `${v.key}=`);
    return out;
  }

  // `enable` flips to true when its optional group is turned on in
  // generate:secrets. In .env.example show the on-value so uncommenting the
  // block is enough.
  if (v.source === "enable") {
    out.push(groupIsOptional ? `# ${v.key}=true` : `${v.key}=true`);
    return out;
  }

  const value = v.example ?? v.default ?? "";
  const live = v.exampleSet && !groupIsOptional;
  out.push(live ? `${v.key}=${value}` : `# ${v.key}=${value}`);
  return out;
}

function renderFile(spec: FileSpec): string {
  const rule = "=".repeat(77);
  const out: string[] = [`# ${rule}`, ...commentBlock(spec.header), `# ${rule}`];

  for (const group of groupsForFile(spec.file)) {
    const vars = varsInGroup(group.id);
    if (vars.length === 0) continue;

    // Optional groups (the ones `generate:secrets` asks a yes/no question
    // about) ship fully commented out — enabling one is a deliberate act.
    const optional = Boolean(group.prompt);

    out.push("", `# --- ${group.title} ${"-".repeat(Math.max(3, 70 - group.title.length))}`);
    if (group.comment) out.push(...commentBlock(group.comment));
    if (optional) out.push("#", "# Disabled by default — uncomment to enable.");

    // Blank line before a var only when it carries its own comment block, so
    // runs of related bare assignments (the SMTP_* block, say) stay contiguous.
    vars.forEach((v, i) => {
      if (i === 0 || v.comment) out.push("");
      out.push(...renderVar(v, optional));
    });
  }

  return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const problems: string[] = [];

// 0. The scan itself must be trustworthy. A spread inside a createEnv object,
//    or an unparseable call, means keys exist that no static reader can see —
//    report that instead of quietly checking a subset.
const scan = scanSchemaKeys(ROOT);
problems.push(...scan.errors);

// 1. Coverage: schema → manifest.
const declared = scan.keys;
const known = new Set(ENV_VARS.map((v) => v.key));
for (const [key, source] of declared) {
  if (!known.has(key)) {
    problems.push(
      `${key} is declared in ${source} but missing from scripts/lib/env-manifest.ts.\n` +
        `    Add an entry to ENV_VARS so \`pnpm generate:secrets\` knows about it, ` +
        `then run \`pnpm env:sync\`.`,
    );
  }
}

// 2. Coverage: manifest → schema (catches typos and stale entries).
for (const v of ENV_VARS) {
  if (v.inSchema === false) continue;
  if (!declared.has(v.key)) {
    problems.push(
      `${v.key} is in scripts/lib/env-manifest.ts but is not declared in any ` +
        `packages/env/src/*.ts schema.\n` +
        `    Either add it to a schema, remove the manifest entry, or mark it ` +
        `\`inSchema: false\` if it is read outside the schemas (e.g. by a shell script).`,
    );
  }
}

// 3. Duplicate keys.
const seen = new Set<string>();
for (const v of ENV_VARS) {
  if (seen.has(v.key)) problems.push(`${v.key} appears more than once in ENV_VARS.`);
  seen.add(v.key);
}

// 4. Every var belongs to a group that exists, and to the same file as that
//    group. Neither is cosmetic: rendering and prompting both walk
//    groups → vars, so a var whose `group` is a typo is silently invisible in
//    the .env.example AND never prompted for, while the key-set checks above
//    still pass. A `file` mismatch renders a var into one .env.example while
//    the generator treats it as belonging to another.
const groupsById = new Map(ENV_GROUPS.map((g) => [g.id, g]));
for (const v of ENV_VARS) {
  const group = groupsById.get(v.group);
  if (!group) {
    problems.push(
      `${v.key} is in group "${v.group}", which does not exist in ENV_GROUPS.\n` +
        `    It would be dropped from every .env.example and never prompted for. ` +
        `Fix the group name or add the group.`,
    );
    continue;
  }
  const varFile = v.file ?? "root";
  const groupFile = group.file ?? "root";
  if (varFile !== groupFile) {
    problems.push(
      `${v.key} declares file "${varFile}" but its group "${group.id}" renders into ` +
        `"${groupFile}".\n    Move the var to a group in the same file, or drop its \`file\`.`,
    );
  }
}

// 5. render.yaml declares every root variable.
//
//    The Blueprint's own header promises it shows every knob in one place, and
//    it is the recommended deploy target — so a variable that exists in the
//    manifest but not there is a knob nobody can find in the Render dashboard.
//    Skipped entirely when render.yaml is absent (deploying elsewhere), and
//    exempting a key requires `blueprintExempt: true` with a stated reason.
//    Checked PER SERVICE, not file-wide. A flat scan of every `key:` in the
//    file would let a variable declared only on the worker satisfy the web
//    service (and vice versa) — the Blueprint would pass this check and then
//    boot a container missing a required var. Which service needs which var
//    comes from the schema that declares it: `packages/env/src/shared.ts` is
//    read by BOTH the server and the worker, `server.ts` by the server only.
const RENDER_YAML = resolve(ROOT, "render.yaml");
if (existsSync(RENDER_YAML)) {
  const yaml = readFileSync(RENDER_YAML, "utf-8");

  // `envVarGroups:` entries are shared by any service that lists `fromGroup`.
  // Split the file there so group keys aren't counted as service-local.
  const groupsAt = yaml.search(/^envVarGroups:/m);
  const servicesSection = groupsAt >= 0 ? yaml.slice(0, groupsAt) : yaml;
  const groupSection = groupsAt >= 0 ? yaml.slice(groupsAt) : "";
  const groupKeys = new Set<string>();
  for (const m of groupSection.matchAll(/^\s*-?\s*key:\s*([A-Z][A-Z0-9_]*)/gm)) {
    groupKeys.add(m[1]!);
  }

  // Each `- type: <kind>` starts a service; collect its own inline keys.
  // Split rather than a lookahead regex: JS has no `\Z`, so the natural
  // "up to the next service or end of input" lookahead silently means "or a
  // literal Z" and drops the final service whenever nothing follows it.
  const services: Array<{ name: string; kind: string; keys: Set<string> }> = [];
  for (const chunk of servicesSection.split(/^ {2}- (?=type:)/m).slice(1)) {
    const body = chunk;
    const kind = /^type:\s*(\S+)/.exec(body)?.[1] ?? "";
    // Only runtime containers read our env; keyvalue/redis services do not.
    if (kind !== "web" && kind !== "worker" && kind !== "pserv" && kind !== "cron") continue;
    const name = /^\s*name:\s*(\S+)/m.exec(body)?.[1] ?? kind;
    const keys = new Set<string>();
    for (const m of body.matchAll(/^\s*-?\s*key:\s*([A-Z][A-Z0-9_]*)/gm)) keys.add(m[1]!);
    // A service that pulls the shared group inherits every key in it.
    if (/^\s*-\s*fromGroup:/m.test(body)) for (const k of groupKeys) keys.add(k);
    services.push({ name, kind, keys });
  }

  // A parser that matches nothing reports "no missing keys" — a pass that looks
  // identical to a real one. render.yaml always declares at least one runtime
  // service, so zero here means the split regex above stopped matching (e.g.
  // a service entry that no longer leads with `type:`), not a clean blueprint.
  if (services.length === 0) {
    problems.push(
      "render.yaml: parsed zero runtime services, so the per-service Blueprint check below " +
        "would pass vacuously (no services to find missing keys on). Every service entry must " +
        "begin with `- type: <kind>` for the split above to see it.",
    );
  }

  const renderTarget = DEPLOY_TARGETS.find((t) => t.id === "render");
  const platformSupplied = new Set<string>(renderTarget?.injects ?? []);

  /** Does this service run the schema that declares `key`? */
  function serviceNeeds(serviceKind: string, key: string): boolean {
    const schemaFile = declared.get(key) ?? "";
    // `shared` is read by every runtime container; anything else is server-side
    // config that only the web service consumes.
    if (schemaFile.includes("shared")) return true;
    // Keyed on `type:`, never on `name:`. Service names are free-form and get
    // prefixed the moment anyone renames the app (`myapp-worker`); matching the
    // literal name "worker" would then demand every server-only var on it.
    //
    // `cron` counts as worker-side too: on this stack a Render cron job runs the
    // worker image, so it reads the shared schema and none of the server-only
    // config. `web` and `pserv` are server-side.
    return serviceKind !== "worker" && serviceKind !== "cron";
  }

  const missingByService: string[] = [];
  for (const service of services) {
    const missing = ENV_VARS.filter(
      (v) =>
        (v.file ?? "root") === "root" &&
        !v.blueprintExempt &&
        !platformSupplied.has(v.key) &&
        serviceNeeds(service.kind, v.key) &&
        !service.keys.has(v.key),
    ).map((v) => v.key);
    if (missing.length > 0) {
      missingByService.push(`    service "${service.name}" is missing: ${missing.join(", ")}`);
    }
  }

  if (missingByService.length > 0) {
    problems.push(
      `render.yaml does not declare every variable its services need:\n${missingByService.join("\n")}\n` +
        `    Add each one to that service (or to the shared envVarGroup) prefilled with its\n` +
        `    default, or \`sync: false\` for a secret — or mark it \`blueprintExempt: true\`\n` +
        `    in the manifest if a Blueprint must not set it.`,
    );
  }
}

// 6. The generated files match the manifest.
//
//    A missing target file is skipped rather than fatal. Removing a feature
//    module is a documented teardown (patterns/removable/*.md) — ripping out
//    the Expo app deletes apps/native/.env.example, and ripping out the web app
//    is possible too. Reading unconditionally here would abort `env:check`
//    *and* `env:sync` with a raw ENOENT stack trace, leaving the developer
//    unable to regenerate the files that do remain. Same guard as the
//    render.yaml check above.
const stale: string[] = [];
for (const spec of FILES) {
  const path = resolve(ROOT, spec.path);
  if (!existsSync(path)) {
    console.log(`[env] skipping ${spec.path} — not present (feature module removed?)`);
    continue;
  }
  const next = renderFile(spec);
  const current = readFileSync(path, "utf-8");
  if (current === next) continue;

  if (CHECK) {
    stale.push(relative(ROOT, path));
  } else {
    writeFileSync(path, next);
    console.log(`[env] wrote ${spec.path}`);
  }
}

if (stale.length > 0) {
  problems.push(
    `${stale.join(", ")} ${stale.length === 1 ? "is" : "are"} out of date.\n` +
      `    Run \`pnpm env:sync\` and commit the result.`,
  );
}

if (problems.length > 0) {
  console.error("\n[env] environment manifest check failed:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(
  CHECK
    ? `[env] OK — manifest covers ${declared.size} schema keys and the .env.example files are current.`
    : `[env] OK — ${declared.size} schema keys covered.`,
);
