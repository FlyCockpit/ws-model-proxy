/**
 * Locale-aware decimal parsing for dashboard numeric fields.
 *
 * Uses the active locale's decimal separator from `Intl.NumberFormat`.
 * Grouping-shaped input is rejected (`1,500` in en-US / es-MX) rather than
 * treated as a decimal. Later comma-decimal locales (de-DE) accept `1,5` and
 * reject grouping (`1.500`).
 */

export function localeNumberParts(locale: string): { decimal: string; grouping: string } {
  try {
    const parts = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234.5);
    return {
      decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
      grouping: parts.find((part) => part.type === "group")?.value ?? ",",
    };
  } catch {
    return { decimal: ".", grouping: "," };
  }
}

/**
 * Canonical ASCII decimal (`1.5`) for a locale-shaped amount, `""` for a
 * blank field, or `null` when the text is not a single ungrouped number.
 */
export function parseLocaleDecimal(raw: string, locale: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const { decimal, grouping } = localeNumberParts(locale);
  if (grouping.length > 0 && grouping !== decimal && trimmed.includes(grouping)) return null;
  let body = trimmed;
  if (decimal !== ".") {
    const first = body.indexOf(decimal);
    if (first !== -1) {
      if (body.indexOf(decimal, first + 1) !== -1) return null;
      body = `${body.slice(0, first)}.${body.slice(first + decimal.length)}`;
    }
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(body)) return null;
  return body;
}
