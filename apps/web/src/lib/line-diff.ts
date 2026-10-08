/**
 * A line diff for the runtime version history: longest common subsequence over lines, then
 * unchanged runs collapsed to a few lines of context. Definitions are small (≤ 48 KiB), so the
 * quadratic table is fine.
 */

export type DiffLine = { kind: "same" | "add" | "remove"; text: string };
export type DiffHunkLine = DiffLine | { kind: "skip"; count: number };

/** Lines are compared exactly; the result lists every line of both sides once. */
export function diffLines(fullBefore: readonly string[], fullAfter: readonly string[]): DiffLine[] {
  // Equal head and tail lines stay out of the table: an edit usually touches a few lines.
  let head = 0;
  while (
    head < fullBefore.length &&
    head < fullAfter.length &&
    fullBefore[head] === fullAfter[head]
  )
    head++;
  let tail = 0;
  while (
    tail < fullBefore.length - head &&
    tail < fullAfter.length - head &&
    fullBefore[fullBefore.length - 1 - tail] === fullAfter[fullAfter.length - 1 - tail]
  )
    tail++;
  const same = (lines: readonly string[]) =>
    lines.map((text): DiffLine => ({ kind: "same", text }));
  const before = fullBefore.slice(head, fullBefore.length - tail);
  const after = fullAfter.slice(head, fullAfter.length - tail);
  return [
    ...same(fullBefore.slice(0, head)),
    ...diffMiddle(before, after),
    ...same(fullBefore.slice(fullBefore.length - tail)),
  ];
}

function diffMiddle(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;
  // lengths[i][j]: LCS length of before[i..] and after[j..].
  const lengths = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i--)
    for (let j = cols - 1; j >= 0; j--)
      lengths[i][j] =
        before[i] === after[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      out.push({ kind: "same", text: before[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      out.push({ kind: "remove", text: before[i++] });
    } else {
      out.push({ kind: "add", text: after[j++] });
    }
  }
  while (i < rows) out.push({ kind: "remove", text: before[i++] });
  while (j < cols) out.push({ kind: "add", text: after[j++] });
  return out;
}

/** Keeps `context` unchanged lines around each change; longer unchanged runs become a skip. */
export function collapseUnchanged(lines: readonly DiffLine[], context = 3): DiffHunkLine[] {
  const changed = lines.map((line) => line.kind !== "same");
  const keep = lines.map((_, index) => {
    for (
      let k = Math.max(0, index - context);
      k <= Math.min(lines.length - 1, index + context);
      k++
    )
      if (changed[k]) return true;
    return false;
  });
  const out: DiffHunkLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) out.push({ kind: "skip", count: skipped });
      skipped = 0;
      out.push(line);
    } else skipped++;
  });
  if (skipped > 0) out.push({ kind: "skip", count: skipped });
  return out;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  return value;
}

/** Pretty JSON with sorted keys, so key order never shows up as a change. */
export function stableJsonLines(value: unknown): string[] {
  return (JSON.stringify(sortKeys(value), null, 2) ?? "").split("\n");
}
