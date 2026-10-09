/** Display formats for request metrics (Overview KPIs, pool stats). */

export function formatMs(value: number | null, lang: string, none: string): string {
  if (value === null) return none;
  return value < 1000
    ? new Intl.NumberFormat(lang, {
        style: "unit",
        unit: "millisecond",
        unitDisplay: "short",
        maximumFractionDigits: 0,
      }).format(value)
    : new Intl.NumberFormat(lang, {
        style: "unit",
        unit: "second",
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(value / 1000);
}

export function formatShare(value: number | null, lang: string, none: string): string {
  if (value === null) return none;
  return new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 1 }).format(value);
}
