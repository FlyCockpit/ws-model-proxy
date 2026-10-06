/**
 * Share invites (owner decision round 3): sharing a pool with an e-mail that has no account yet.
 *
 * The token (`wsmp_inv_` + 26 base32 characters, 130 random bits) is shown once: e-mailed when
 * SMTP is configured, otherwise returned to the owner to copy. Only its purpose HMAC is stored
 * (`credentialDigest("shareInvite", token)`, 64 hex characters, the hardening shape).
 *
 * Acceptance lives in `@ws-model-proxy/auth/share-invite-acceptance` (Better Auth hooks).
 */
import { randomBytes } from "node:crypto";
import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import type { Prisma } from "@ws-model-proxy/db";
import { credentialDigest, PRODUCT_CREDENTIAL_PREFIXES } from "@ws-model-proxy/db/node-security";
import { env } from "@ws-model-proxy/env/server";
import { isEmailConfigured, renderShareInvite, sendEmail } from "@ws-model-proxy/mailer";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const SHARE_INVITE_TOKEN_PATTERN = /^wsmp_inv_[A-Z2-7]{26}$/;
/** How long an invite link works (the hardening allows at most 30 days). */
export const SHARE_INVITE_TTL_MS = 14 * 86_400_000;
/** Pending invites one owner may have at once (each one can send an e-mail). */
export const SHARE_INVITE_MAX_PENDING_PER_OWNER = 50;

/** 26 base32 characters from 17 random bytes (the first 130 of 136 bits). */
export function generateShareInviteToken(): string {
  const bytes = randomBytes(17);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return `${PRODUCT_CREDENTIAL_PREFIXES.shareInvite}${out}`;
}

export function shareInviteDigest(token: string): string {
  return credentialDigest("shareInvite", token);
}

/** The invite sign-up page: `/{lang}/signup?invite=<token>`. */
export function shareInviteUrl(token: string, locale: string | null | undefined): string {
  const lang = locale && isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const url = new URL(`/${lang}/signup`, env.BETTER_AUTH_URL);
  url.searchParams.set("invite", token);
  return url.toString();
}

/**
 * E-mails the invite when SMTP is configured. Returns whether it was sent; a failure is not an
 * error (the owner then gets the link to copy).
 */
export async function sendShareInviteEmail(args: {
  to: string;
  ownerName: string;
  callableId: string;
  token: string;
  expiresAt: Date;
  locale: string | null | undefined;
}): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  try {
    const { subject, html } = renderShareInvite({
      ownerName: args.ownerName,
      callableId: args.callableId,
      inviteUrl: shareInviteUrl(args.token, args.locale),
      expiresAt: args.expiresAt,
      locale: args.locale ?? DEFAULT_LOCALE,
    });
    await sendEmail({ to: args.to, subject, html });
    return true;
  } catch {
    return false;
  }
}

/** A pending invite: neither accepted nor revoked, and not expired. */
export function pendingInviteWhere(now: Date): Prisma.ShareInviteWhereInput {
  return { acceptedAt: null, revokedAt: null, expiresAt: { gt: now } };
}
