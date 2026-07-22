/**
 * Static extraction of the env keys declared in `packages/env/src/**.ts`.
 *
 * Static rather than dynamic on purpose: importing `@ws-model-proxy/env/server`
 * runs validation, which throws in CI where none of these variables are set.
 *
 * Everything here is driven by ONE tokenizer (`walk`) that understands strings,
 * template literals, both comment forms, and regex literals. That is not
 * gold-plating — every hole this file has had came from matching raw text:
 *
 *   - A hardcoded file list missed a newly added schema file.
 *   - A `/^ {4}KEY:/` line regex missed keys that weren't formatted as expected
 *     and invented phantom ones from unrelated objects.
 *   - A regex used to LOCATE `server: {` matched the same text inside a comment
 *     or a string, so a single explanatory comment could silently swap the real
 *     key set for a decoy one — with no error raised.
 *
 * So: nothing in this module may match against raw source. Find structure with
 * the tokenizer, then read keys out of the structure.
 *
 * That rule is why `walk` reports string tokens (`onString`) as well as bare
 * characters. Quoted keys (`"FOO": z.string()`) are strings, so a tokenizer
 * that only skips string bodies cannot see them — and the obvious shortcut, a
 * regex for `"KEY":` over the object body, is precisely the failure class
 * listed above: it invents a phantom key from any `{"LOOKS_LIKE_A_KEY": …}`
 * that happens to appear inside a `.describe(…)` hint. A quoted key is
 * therefore recognised structurally: a string at the object's own depth whose
 * closing quote is followed by `:`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

interface SchemaScan {
  /** key → repo-relative file that declares it */
  keys: Map<string, string>;
  /**
   * Problems that make the scan UNTRUSTWORTHY rather than merely empty.
   * Callers must treat a non-empty list as fatal: a degraded scan silently
   * under-reports keys, which is exactly the failure the scan exists to catch.
   */
  errors: string[];
}

/** A `key: value` pair found at the top level of an object literal. */
interface Entry {
  key: string;
  /** Index of the first non-space character of the value. */
  valueStart: number;
}

/** Characters after which a `/` begins a regex literal rather than division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";"]);

/**
 * `createEnv` options whose object literal declares environment variables. Every
 * one is scanned for SCREAMING_SNAKE keys; each key found must have a manifest
 * entry. `shared` counts — it is validated at runtime exactly like `server`.
 */
const VAR_SECTIONS = new Set(["server", "client", "shared"]);

/**
 * `createEnv` options that are NOT variable declarations, so finding
 * SCREAMING_SNAKE keys inside them (`runtimeEnv` is full of them) means nothing.
 * Listed explicitly so an option missing from BOTH sets is an error rather than
 * a silent skip. From t3-env's `createEnv` signature — extend when it does.
 */
const NON_VAR_OPTIONS = new Set([
  "runtimeEnv",
  "runtimeEnvStrict",
  "experimental__runtimeEnv",
  "clientPrefix",
  "isServer",
  "skipValidation",
  "emptyStringAsUndefined",
  "extends",
  "onValidationError",
  "onInvalidAccess",
  "createFinalSchema",
]);

/**
 * Walks `source` from `from` to `to`, invoking `onChar` for characters that are
 * real code (not inside a string, comment, or regex literal). Returns the index
 * just past the matching `}` when `stopAtDepthZero` is set.
 */
function walk(
  source: string,
  from: number,
  to: number,
  onChar: (ch: string, index: number, depth: number) => void,
  // Reports a complete string/template token: its body, the index of its
  // opening quote, and the depth it sits at. Quoted object keys (`"FOO": …`)
  // are strings, so they are invisible to `onChar` — this is how a caller sees
  // them without falling back to matching raw source, which this module's
  // header rule forbids.
  onString: (value: string, index: number, depth: number) => void = () => {},
): { ok: boolean; end: number } {
  let depth = 0;
  let lastSignificant = "";
  let i = from;

  for (; i < to; i++) {
    const ch = source[i]!;
    const next = source[i + 1];

    // --- comments ---
    if (ch === "/" && next === "/") {
      while (i < to && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < to && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      continue;
    }

    // --- regex literal (a `/` in value position, e.g. z.string().regex(/[{]/)) ---
    if (ch === "/" && REGEX_PRECEDERS.has(lastSignificant)) {
      i++;
      let inClass = false;
      for (; i < to; i++) {
        const r = source[i]!;
        if (r === "\\") {
          i++;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
        else if (r === "\n") break; // unterminated — bail rather than swallow the file
      }
      lastSignificant = "/";
      continue;
    }

    // --- strings and template literals ---
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const open = i;
      i++;
      const bodyStart = i;
      for (; i < to; i++) {
        const s = source[i]!;
        if (s === "\\") {
          i++;
          continue;
        }
        if (s === quote) break;
      }
      onString(source.slice(bodyStart, Math.min(i, to)), open, depth);
      lastSignificant = quote;
      continue;
    }

    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0 && (ch === "}" || ch === ")")) {
        onChar(ch, i, depth);
        return { ok: true, end: i + 1 };
      }
    }

    onChar(ch, i, depth);
    if (!/\s/.test(ch)) lastSignificant = ch;
  }

  return { ok: false, end: i };
}

/** Index just past the `{`…matching `}` beginning at `open`, or -1. */
function matchBrace(source: string, open: number): number {
  const result = walk(source, open, source.length, () => {});
  return result.ok ? result.end : -1;
}

/**
 * Top-level `key:` entries of the object literal whose `{` is at `open`.
 * Handles bare, quoted, and single-quoted keys; reports spreads separately
 * because their contents cannot be resolved statically.
 */
function objectEntries(
  source: string,
  open: number,
): { entries: Entry[]; hasSpread: boolean; ok: boolean } {
  const entries: Entry[] = [];
  let hasSpread = false;
  let token = "";
  // A quoted key at this object's own depth, waiting for its `:` to confirm it
  // is a key rather than a value. Reset by any other significant character, so
  // a string in value position (`.describe("…")`, a default) can never be
  // mistaken for one.
  let pendingQuotedKey: { name: string; end: number } | null = null;

  const result = walk(
    source,
    open,
    source.length,
    (ch, index, depth) => {
      // `index === open` is the object's own `{`, which the tokenizer reports at
      // depth 1 like any other character. Including it would prefix the first
      // key's token with "{" and make it unrecognisable.
      if (depth !== 1 || index === open) return;

      if (ch === "," || ch === "}" || ch === ")" || ch === "]") {
        token = "";
        pendingQuotedKey = null;
        return;
      }

      if (ch === ":") {
        // A quoted key only counts when the `:` directly follows its closing
        // quote (whitespace aside). That is what separates `"FOO": z.string()`
        // from a colon inside, or after, some unrelated string.
        const quoted = pendingQuotedKey;
        pendingQuotedKey = null;
        if (quoted && source.slice(quoted.end, index).trim() === "") {
          let v = index + 1;
          while (v < source.length && /\s/.test(source[v]!)) v++;
          entries.push({ key: quoted.name, valueStart: v });
          token = "";
          return;
        }

        const name = token.trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
          let v = index + 1;
          while (v < source.length && /\s/.test(source[v]!)) v++;
          entries.push({ key: name, valueStart: v });
        }
        token = "";
        return;
      }

      if (source.startsWith("...", index)) hasSpread = true;
      if (!/\s/.test(ch)) pendingQuotedKey = null;
      token += ch;
    },
    (value, index, depth) => {
      // Only strings sitting directly in this object's body can be keys.
      if (depth !== 1) return;
      // `index` is the opening quote; the closing quote is one past the body.
      pendingQuotedKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)
        ? { name: value, end: index + value.length + 2 }
        : null;
    },
  );

  return { entries, hasSpread, ok: result.ok };
}

/** Every `.ts` under `dir`, recursively. */
function schemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...schemaFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts")) continue;
    out.push(full);
  }
  return out.sort();
}

/**
 * Scans every `packages/env/src/**.ts` for keys declared inside the `server:`
 * or `client:` object of a `createEnv({…})` call.
 */
export function scanSchemaKeys(root: string): SchemaScan {
  const dir = resolve(root, "packages/env/src");
  const keys = new Map<string, string>();
  const errors: string[] = [];

  for (const path of schemaFiles(dir)) {
    const rel = relative(root, path);
    const source = readFileSync(path, "utf-8");

    // Locate createEnv calls structurally: find the identifier, then take the
    // object literal that follows. Matching the text "createEnv(" directly is
    // safe only because we immediately hand off to the tokenizer.
    let searchFrom = 0;
    for (;;) {
      const call = source.indexOf("createEnv(", searchFrom);
      if (call < 0) break;
      searchFrom = call + "createEnv(".length;

      const objectStart = source.indexOf("{", call);
      if (objectStart < 0) continue;
      const objectEnd = matchBrace(source, objectStart);
      if (objectEnd < 0) {
        errors.push(
          `${rel}: could not parse the createEnv({…}) call — unbalanced braces, or a ` +
            `construct this scanner does not understand. The env manifest check cannot ` +
            `verify this file until it parses.`,
        );
        break;
      }
      searchFrom = objectEnd;

      const { entries, ok, hasSpread } = objectEntries(source, objectStart);
      if (!ok) {
        errors.push(`${rel}: could not parse the createEnv({…}) config object.`);
        continue;
      }
      // A spread at the top level (`createEnv({ ...baseConfig })`) hides the
      // `server` / `client` / `shared` sections themselves, so the scan below
      // would find nothing and silently report full coverage of zero keys.
      if (hasSpread) {
        errors.push(
          `${rel}: the createEnv({…}) config object uses a spread (\`...\`), whose keys cannot ` +
            `be read statically.\n    Declare the \`server\` / \`client\` sections inline so ` +
            `\`pnpm env:check\` can see them.`,
        );
      }

      for (const entry of entries) {
        // An option we don't recognize is a hard error, not something to skip.
        // Silently ignoring one is the exact failure this module exists to
        // prevent: a key declared in an unscanned section needs no manifest
        // entry, never reaches `.env.example`, is never prompted by
        // `generate:secrets`, and is never zeroed before validation — so a
        // broken production block can validate green against the repo's own
        // `.env`. `shared` is the live example (a documented t3-env section
        // that this scanner did not read); the allowlist below is what keeps
        // the next one from being invisible too.
        if (!VAR_SECTIONS.has(entry.key)) {
          if (!NON_VAR_OPTIONS.has(entry.key)) {
            errors.push(
              `${rel}: unrecognized createEnv option \`${entry.key}\`. If it declares env ` +
                `keys, add it to VAR_SECTIONS in scripts/lib/env-schema.ts; if not, add it ` +
                `to NON_VAR_OPTIONS. Refusing to report coverage while a section is unread.`,
            );
          }
          continue;
        }
        if (source[entry.valueStart] !== "{") continue;

        const sectionEnd = matchBrace(source, entry.valueStart);
        if (sectionEnd < 0) {
          errors.push(`${rel}: could not parse the \`${entry.key}\` object.`);
          continue;
        }

        const section = objectEntries(source, entry.valueStart);
        if (!section.ok) {
          errors.push(`${rel}: could not parse the \`${entry.key}\` object.`);
          continue;
        }
        if (section.hasSpread) {
          errors.push(
            `${rel}: the \`${entry.key}\` object uses a spread (\`...\`), whose keys cannot ` +
              `be read statically.\n    Declare env keys inline so \`pnpm env:check\` can see them.`,
          );
        }

        // Bare and quoted keys both come out of the tokenizer now — nothing
        // here reads raw source, so a SCREAMING_SNAKE token inside a
        // `.describe("…")` hint can no longer be mistaken for a declaration.
        for (const name of section.entries.map((e) => e.key)) {
          // Env keys are SCREAMING_SNAKE by convention; anything else in these
          // objects is not a variable.
          if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
          if (!keys.has(name)) keys.set(name, rel);
        }
      }
    }
  }

  return { keys, errors };
}
