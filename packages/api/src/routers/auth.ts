import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { verifyTransport } from "@ws-model-proxy/mailer";
import { contractProcedure, publicContractProcedure } from "../contract-procedure";
import { authContract as c } from "../contracts/account";
import { callableIdOf } from "../lib/access-views";
import { canUserChangePassword } from "../lib/password-capabilities";
import { acceptShareInviteByLink } from "../lib/share-invite-accept";
import { pendingInviteWhere, shareInviteDigest } from "../lib/share-invites";

export const authRouter = {
  /**
   * The invite sign-up page: who invited this e-mail to which pool. Answers `valid: false`
   * (and nothing else) for an unknown, used, withdrawn or expired link, so it reveals nothing
   * without a live token. Charged to the caller's address like sign-in (`limitInviteLookup`).
   * The limiter is in-memory, per server process: with several replicas each one keeps its
   * own budget. Without the service (MCP, or an unwired server) the lookup is refused.
   */
  inviteInfo: publicContractProcedure(c.inviteInfo).handler(async ({ input, context }) => {
    const limit = context.services?.limitInviteLookup;
    if (!limit)
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Invite lookups are unavailable.",
      });
    if (!(await limit()))
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "Too many invite lookups. Try again later.",
      });
    const invite = await prisma.shareInvite.findFirst({
      where: { tokenDigest: shareInviteDigest(input.token), ...pendingInviteWhere(new Date()) },
      select: {
        email: true,
        Owner: { select: { name: true } },
        Pool: { select: { slug: true, User: { select: { slug: true } } } },
      },
    });
    if (!invite) return { valid: false, email: null, ownerName: null, callableId: null };
    return {
      valid: true,
      email: invite.email,
      ownerName: invite.Owner.name,
      callableId: callableIdOf(invite.Pool.User.slug, invite.Pool.slug),
    };
  }),
  /**
   * A signed-in person opening an invite link accepts it, whatever their e-mail (the token is
   * the proof). Charged per user (`limitInviteAccept`, in-memory per server process); refused
   * without the service.
   */
  acceptInvite: contractProcedure(c.acceptInvite).handler(async ({ input, context }) => {
    const limit = context.services?.limitInviteAccept;
    if (!limit)
      throw new ORPCError("SERVICE_UNAVAILABLE", {
        message: "Invite acceptance is unavailable.",
      });
    if (!(await limit(context.session.user.id)))
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: "Too many invite attempts. Try again later.",
      });
    const result = await acceptShareInviteByLink(
      { id: context.session.user.id, email: context.session.user.email },
      input.token,
    );
    return { result };
  }),
  /**
   * Delivery-aware preflight for the email-OTP second factor. The login challenge calls this
   * BEFORE `authClient.twoFactor.sendOtp()` because Better Auth's send-otp endpoint swallows
   * `sendOTP` failures and always returns success.
   *
   * Public: the caller is mid-2FA (password verified, no full session yet). It is rate-limited
   * by the shared `/rpc` limiter and only handshakes the app's own SMTP host.
   */
  verifyEmailTransport: publicContractProcedure(c.verifyEmailTransport).handler(async () => {
    return { ok: await verifyTransport() };
  }),
  /** Persist the signed-in person's UI locale so it follows them across devices. */
  updateLocale: contractProcedure(c.updateLocale).handler(async ({ input, context }) => {
    await prisma.user.update({
      where: { id: context.session.user.id },
      data: { locale: input.locale },
    });
    return { success: true as const };
  }),
  passwordCapabilities: contractProcedure(c.passwordCapabilities).handler(async ({ context }) => {
    return {
      canChangePassword: await canUserChangePassword({
        userId: context.session.user.id,
        forceSso: false,
      }),
    };
  }),
};
