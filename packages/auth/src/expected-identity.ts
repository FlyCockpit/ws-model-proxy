import { APIError, getSession, type getSessionFromCtx } from "better-auth/api";

/** Compare the cookie owner before ban, impersonation or account policy can hide it. */
export async function refuseUnexpectedIdentity(
  ctx: Parameters<typeof getSessionFromCtx>[0],
): Promise<void> {
  if (ctx.path === "/get-session" || ctx.path === "/sign-out") return;
  const expected = ctx.headers?.get("X-Expected-User");
  if (!expected) return;
  const session =
    ctx.context.session ??
    (await getSession()({
      ...ctx,
      headers: ctx.headers ?? ctx.request?.headers ?? new Headers(),
      method: "GET",
      asResponse: false,
      returnHeaders: false,
      returnStatus: false,
      query: {},
    }).catch(() => {
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "SESSION_UNAVAILABLE",
        message: "Session verification unavailable",
      });
    }));
  if (session?.user.id && session.user.id !== expected) {
    throw new APIError("CONFLICT", {
      code: "IDENTITY_CHANGED",
      message: "Document identity changed",
    });
  }
}
