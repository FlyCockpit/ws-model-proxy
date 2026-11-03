/** "12.5 GB" with at most one decimal. */
export function formatGb(value: number | null, lang: string): string | null {
  if (value === null) return null;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(value)} GB`;
}
