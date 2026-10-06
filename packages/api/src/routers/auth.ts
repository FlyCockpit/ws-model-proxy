import prisma from "@ws-model-proxy/db";
import { verifyTransport } from "@ws-model-proxy/mailer";
import { contractProcedure, publicContractProcedure, publicStub } from "../contract-procedure";
import { authContract as c } from "../contracts/account";
import { canUserChangePassword } from "../lib/password-capabilities";

export const authRouter = {
  /** The invite sign-up page (lane B2). */
  inviteInfo: publicStub(c.inviteInfo),
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
