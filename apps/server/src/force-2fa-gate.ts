import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { openAiErrorBody } from "./model-api/openai-errors.js";

/** Dashboard session policy; anonymous callers keep their route's own 401. */
export async function forcedTwoFactorResponse(
  session: Session | null | undefined,
  twoFactorRequired = isForceTwoFactorRequired,
): Promise<Response | undefined> {
  const user = session?.user;
  if (user && !user.twoFactorEnabled && (await twoFactorRequired())) {
    return Response.json(
      openAiErrorBody({
        message: "Two-factor authentication setup is required.",
        type: "invalid_request_error",
        code: "two_factor_required",
      }),
      { status: 403 },
    );
  }
}
