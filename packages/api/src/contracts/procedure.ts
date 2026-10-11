/**
 * The descriptor every 0.4.0 oRPC procedure contract uses. Implementations (S0c stubs, then
 * the lanes) bind it to the matching base procedure:
 *
 * | access        | base procedure                         | MCP                  |
 * |---------------|----------------------------------------|----------------------|
 * | `public`      | `publicProcedure` (kept 0.3 plumbing)  | never                |
 * | `session`     | `protectedProcedure`                   | never                |
 * | `agent`       | `protectedProcedure` + tool checks     | through `tools` only |
 * | `human`       | `humanProcedure` (positive check)      | never                |
 * | `admin`       | `adminProcedure`                       | never                |
 * | `human_admin` | `humanProcedure` + admin               | never                |
 *
 * `human` is a positive check (§6.3): a cookie-authenticated Better Auth session, the
 * CSRF/origin check, and no agent marker in context. A test calls every `human`/`human_admin`
 * procedure with a Full agent token, an OAuth access token and an API key and expects FORBIDDEN.
 *
 * Only two kept procedures are public (`app.config`, `auth.verifyEmailTransport`): sign-up and
 * sign-in stay Better Auth routes, and the node enrollment exchange is plain HTTP (`http.ts`).
 */
import type { z } from "zod";
import type { McpToolName } from "./tool-names";

export const PROCEDURE_ACCESS = [
  "public",
  "session",
  "agent",
  "human",
  "admin",
  "human_admin",
] as const;
export type ProcedureAccess = (typeof PROCEDURE_ACCESS)[number];

export type ProcedureContract<
  Input extends z.ZodType = z.ZodType,
  Output extends z.ZodType = z.ZodType,
> = {
  kind: "query" | "mutation";
  access: ProcedureAccess;
  input: Input;
  output: Output;
  /** One line: what it does (and, for `agent`, the extra rules agents meet). */
  summary: string;
  /** MCP tools that call this procedure (only for `agent`). */
  tools?: readonly McpToolName[];
};

export function query<Input extends z.ZodType, Output extends z.ZodType>(
  access: ProcedureAccess,
  input: Input,
  output: Output,
  summary: string,
  tools?: readonly McpToolName[],
): ProcedureContract<Input, Output> {
  return { kind: "query", access, input, output, summary, ...(tools ? { tools } : {}) };
}

export function mutation<Input extends z.ZodType, Output extends z.ZodType>(
  access: ProcedureAccess,
  input: Input,
  output: Output,
  summary: string,
  tools?: readonly McpToolName[],
): ProcedureContract<Input, Output> {
  return { kind: "mutation", access, input, output, summary, ...(tools ? { tools } : {}) };
}

/** A router contract: procedures, possibly nested one level (`nodes.enrollmentCodes.create`). */
export type RouterContract = {
  readonly [name: string]: ProcedureContract | RouterContract;
};

export function isProcedureContract(
  value: ProcedureContract | RouterContract,
): value is ProcedureContract {
  return "kind" in value && "access" in value && "input" in value;
}

/** Flattens a contract tree into `router.sub.procedure` paths. */
export function flattenContract(
  tree: RouterContract,
  prefix = "",
): Array<[path: string, procedure: ProcedureContract]> {
  return Object.entries(tree).flatMap(([name, value]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return isProcedureContract(value)
      ? [[path, value] as [string, ProcedureContract]]
      : flattenContract(value, path);
  });
}
