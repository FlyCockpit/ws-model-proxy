/**
 * Binds a procedure contract (`contracts/*.ts`) to an oRPC procedure: the access check comes
 * from the contract's access tag, and the input/output validators are the contract's zod.
 * A lane implements a procedure by replacing `stub(c.x)` with
 * `contractProcedure(c.x).handler(...)`; it never restates the shapes.
 */
import { ORPCError, os } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { z } from "zod";
import type { Context } from "./context";
import type { ProcedureContract } from "./contracts/procedure";
import { assertAccess } from "./index";

const o = os.$context<Context>();

/** The context a bound, non-public procedure's handler sees: the session is present. */
export type SignedInContext = Context & { session: Session };

function signedInBase(contract: ProcedureContract) {
  return o.use(async ({ context, next }) => {
    if (contract.access === "public") {
      throw new Error("A public contract is bound with publicContractProcedure");
    }
    const session = await assertAccess(contract.access, context);
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

export const NOT_IMPLEMENTED_MESSAGE = "Not implemented yet.";

function notImplemented(): never {
  throw new ORPCError("NOT_IMPLEMENTED", { message: NOT_IMPLEMENTED_MESSAGE });
}

/** S0c: the procedure exists with its contract and access check; the lane implements it. */
export function stub<Input extends z.ZodType, Output extends z.ZodType>(
  contract: ProcedureContract<Input, Output>,
) {
  return contractProcedure(contract).handler(notImplemented);
}

/** S0c: a public procedure that exists with its contract; the lane implements it. */
export function publicStub<Input extends z.ZodType, Output extends z.ZodType>(
  contract: ProcedureContract<Input, Output>,
) {
  return publicContractProcedure(contract).handler(notImplemented);
}
