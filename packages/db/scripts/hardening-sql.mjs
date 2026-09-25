/**
 * The body of schema-hardening.sql without its outer `BEGIN;` / `COMMIT;`.
 *
 * apply-schema-hardening.mjs runs the body inside its own transaction and
 * records the version-gate key before COMMIT, so the key and the DDL commit
 * together. That holds only if the file's own transaction statements are
 * really removed: a `COMMIT;` left in the body would commit the DDL (and
 * release the deploy locks) before the key is recorded. So this parser is
 * strict and fails closed:
 * - the outer `BEGIN;` and `COMMIT;` must each be alone on their line;
 * - only blank lines and `--` comments may precede `BEGIN;` or follow
 *   `COMMIT;`;
 * - the remaining body may not contain another top-level transaction
 *   statement (`BEGIN;`, `COMMIT;`, `ROLLBACK;`, `START TRANSACTION;`) on a
 *   line of its own. PL/pgSQL function bodies open with `BEGIN` (no
 *   semicolon) and close with `END;`, which is therefore not checked (in
 *   plain SQL `END;` would commit; the file does not use it).
 */
const TRANSACTION_LINE = /^\s*(?:BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;\s*(?:--.*)?$/i;
const IGNORABLE_LINE = /^\s*(?:--.*)?$/;

export function hardeningSqlBody(sql) {
  const lines = sql.split("\n");
  const begin = lines.findIndex((line) => /^BEGIN\s*;\s*$/i.test(line.trim()));
  let commit = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^COMMIT\s*;\s*$/i.test((lines[index] ?? "").trim())) {
      commit = index;
      break;
    }
  }
  if (begin < 0 || commit <= begin) {
    throw new Error("schema-hardening.sql must be wrapped in BEGIN; ... COMMIT; lines");
  }
  const outside = [...lines.slice(0, begin), ...lines.slice(commit + 1)];
  if (!outside.every((line) => IGNORABLE_LINE.test(line))) {
    throw new Error("schema-hardening.sql has statements outside its BEGIN; ... COMMIT; block");
  }
  const body = lines.slice(begin + 1, commit);
  const nested = body.find((line) => TRANSACTION_LINE.test(line));
  if (nested !== undefined) {
    throw new Error(`schema-hardening.sql body has a transaction statement: ${nested.trim()}`);
  }
  return body.join("\n");
}
