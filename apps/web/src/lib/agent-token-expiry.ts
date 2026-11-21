const DAY_MS = 86_400_000;

export function agentTokenExpiryPresets(maxLifetimeDays: number): number[] {
  return [...new Set([7, 30, 90, maxLifetimeDays])]
    .filter((days) => days <= maxLifetimeDays)
    .sort((a, b) => a - b);
}

/** Date inputs use the person's local calendar, rather than UTC's potentially different day. */
export function localDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function agentTokenExpiry(
  choice: string,
  customDate: string,
  now: number,
  maxLifetimeDays: number,
  allowNoExpiry: boolean,
): string | null | undefined {
  if (choice === "never") return allowNoExpiry ? null : undefined;
  if (choice === "custom") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customDate)) return undefined;
    if (customDate <= localDateInputValue(new Date(now))) return undefined;
    const date = new Date(`${customDate}T00:00:00`);
    const expires = date.getTime();
    if (localDateInputValue(date) !== customDate) return undefined;
    return expires > now && expires <= now + maxLifetimeDays * DAY_MS
      ? date.toISOString()
      : undefined;
  }
  const days = Number(choice);
  return Number.isInteger(days) && days >= 1 && days <= maxLifetimeDays
    ? new Date(now + days * DAY_MS).toISOString()
    : undefined;
}
