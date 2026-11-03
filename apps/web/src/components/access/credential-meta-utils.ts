export type CredentialDates = {
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type CredentialStatus = "active" | "expired" | "revoked";

export function credentialStatus(row: CredentialDates, now: number): CredentialStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now) return "expired";
  return "active";
}

export const EXPIRY_CHOICES = ["d7", "d30", "d90", "y1", "never"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

const EXPIRY_DAYS: Record<Exclude<ExpiryChoice, "never">, number> = {
  d7: 7,
  d30: 30,
  d90: 90,
  y1: 364,
};

/** The ISO expiry for a choice (a year is 364 days so it stays inside the server's cap). */
export function expiryFromChoice(choice: ExpiryChoice, now: number): string | null {
  if (choice === "never") return null;
  return new Date(now + EXPIRY_DAYS[choice] * 86_400_000).toISOString();
}
