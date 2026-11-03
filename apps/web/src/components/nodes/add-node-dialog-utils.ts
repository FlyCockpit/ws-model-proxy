export function parseLabels(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
}
