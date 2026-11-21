/**
 * Binds a procedure contract (`contracts/*.ts`) to an oRPC procedure: the access check comes
 * from the contract's access tag, and the input/output validators are the contract's zod.
 * A router implements a procedure with `contractProcedure(c.x).handler(...)`; it never restates
 * the shapes.
 */
import { ORPCError, os } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { z } from "zod";
import type { Context } from "./context";
import { agentToolAllowed } from "./contracts/agent-scopes";
import type { ProcedureContract } from "./contracts/procedure";
import { assertAccess } from "./index";
import { refuseImpersonatedChange } from "./lib/refuse";

const o = os.$context<Context>();

/** The context a bound, non-public procedure's handler sees: the session is present. */
export type SignedInContext = Context & { session: Session };

export function assertContractAgentScope(contract: ProcedureContract, auth: Context["auth"]): void {
  if (
    contract.access === "agent" &&
    (auth.kind === "agent_token" || auth.kind === "oauth_access_token") &&
    !contract.tools?.some((tool) => agentToolAllowed(auth.access, tool))
  ) {
    throw new ORPCError("FORBIDDEN", { message: "This credential does not allow this operation." });
  }
}

function signedInBase(contract: ProcedureContract) {
  return o.use(async ({ context, next }) => {
    if (contract.access === "public") {
      throw new Error("A public contract is bound with publicContractProcedure");
    }
    const session = await assertAccess(contract.access, context);
    assertContractAgentScope(contract, context.auth);
    if (contract.kind === "mutation") refuseImpersonatedChange(session.session);
    return next({ context: { session } });
  });
}

/** A non-public procedure bound to its contract. */
export function contractProcedure<Input extends z.ZodType, Output extends z.ZodType>(
  contract: ProcedureContract<Input, Output>,
) {
  return signedInBase(contract).input(contract.input).output(contract.output);
}

/** A public procedure (only `app.config` and `auth.verifyEmailTransport`). */
export function publicContractProcedure<Input extends z.ZodType, Output extends z.ZodType>(
  contract: ProcedureContract<Input, Output>,
) {
  if (contract.access !== "public") {
    throw new Error("publicContractProcedure binds only public contracts");
  }
  return o.input(contract.input).output(contract.output);
}
