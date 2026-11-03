/**
 * Shared `Intl` formatters, built once per locale and options. Building one is slow, and the
 * locale follows the current i18next language, so instances are cached per locale and options
 * instead of hoisted to a single module constant.
 */
const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.NumberFormat | Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  kind: string,
  lang: string,
  options: object | undefined,
  build: () => T,
): T {
  const key = `${kind}\u0000${lang}\u0000${JSON.stringify(options ?? {})}`;
  let format = cache.get(key) as T | undefined;
  if (!format) {
    format = build();
    cache.set(key, format);
  }
  return format;
}

export function numberFormat(lang: string, options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  // react-doctor-disable-next-line react-doctor/js-hoist-intl -- built once per kind, locale and options, then cached above
  return cached("number", lang, options, () => new Intl.NumberFormat(lang, options));
}

export function dateTimeFormat(
  lang: string,
  options?: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  // react-doctor-disable-next-line react-doctor/js-hoist-intl -- built once per kind, locale and options, then cached above
  return cached("date", lang, options, () => new Intl.DateTimeFormat(lang, options));
}

export function relativeTimeFormat(
  lang: string,
  options?: Intl.RelativeTimeFormatOptions,
): Intl.RelativeTimeFormat {
  // react-doctor-disable-next-line react-doctor/js-hoist-intl -- built once per kind, locale and options, then cached above
  return cached("relative", lang, options, () => new Intl.RelativeTimeFormat(lang, options));
}

/** Compact counts ("1.2K") for KPI tiles. */
export const COMPACT_COUNT: Intl.NumberFormatOptions = {
  notation: "compact",
  maximumFractionDigits: 1,
};
