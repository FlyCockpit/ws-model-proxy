/** Colors repeat after this many lines (dashed from then on). */
export const PALETTE_SIZE = 8;

export function colorOf(index: number): string {
  return `var(--chart-${(index % PALETTE_SIZE) + 1})`;
}
