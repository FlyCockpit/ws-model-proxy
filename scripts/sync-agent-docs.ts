/**
 * Reads AGENTS.md and writes byte-identical mirror copies to each target.
 * Run: `pnpm sync:agent-docs`
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname!, "..");

// ---------------------------------------------------------------------------
// Config — add new targets here
// ---------------------------------------------------------------------------

interface Target {
  /** Path relative to the repo root */
  path: string;
  /** Banner prepended before AGENTS.md content */
  banner: string;
}

const HTML_BANNER =
  "<!-- GENERATED FROM AGENTS.md — DO NOT EDIT. Run `pnpm sync:agent-docs` after editing AGENTS.md. -->";

// .cursorrules is a Markdown file consumed by Cursor. HTML comments work fine
// in Markdown, but wrapping in a blockquote makes intent clearer in the Cursor
// UI without breaking parsing.
const CURSORRULES_BANNER = `> **Note:** ${HTML_BANNER}`;

const TARGETS: Target[] = [
  { path: "CLAUDE.md", banner: HTML_BANNER },
  { path: ".cursorrules", banner: CURSORRULES_BANNER },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const source = readFileSync(resolve(ROOT, "AGENTS.md"), "utf-8");

for (const target of TARGETS) {
  const abs = resolve(ROOT, target.path);
  mkdirSync(dirname(abs), { recursive: true });
  const content = `${target.banner}\n\n${source}`;
  writeFileSync(abs, content, "utf-8");
  console.log(`✓ ${target.path}`);
}
