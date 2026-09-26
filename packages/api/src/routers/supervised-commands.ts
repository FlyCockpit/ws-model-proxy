import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { protectedProcedure } from "../index";
import {
  type PendingSupervisedRequest,
  SUPERVISED_REVIEW_OUTPUT_MAX_CHARS,
} from "../lib/supervised-command-types";

const commandIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "Expected a command id.");

/**
 * Human-only surface for agent-requested (supervised) commands. Session
 * authenticated and owner-scoped; never an MCP tool (see MCP_TOOL_EXCLUSIONS in
 * apps/server/src/mcp/tool-manifest.ts): an agent must not be able to answer
 * its own request or review its own output.
 */
export const supervisedCommandsRouter = {
  /** Requests waiting for this user: confirm on the CLI screen, or review output. */
  pending: protectedProcedure.handler(({ context }): { requests: PendingSupervisedRequest[] } => {
    const services = context.services?.supervisedCommands;
    return { requests: services ? services.listPending(context.session.user.id) : [] };
  }),

  /**
   * The reviewed output for a finished supervised command whose output was
   * held for review. `output: null` redacts everything. Accepted only while
   * the command awaits review; the first submission wins.
   */
  submitOutput: protectedProcedure
    .input(
      z.object({
        commandId: commandIdSchema,
        output: z.string().max(SUPERVISED_REVIEW_OUTPUT_MAX_CHARS).nullable(),
        edited: z.boolean(),
      }),
    )
    .handler(({ input, context }) => {
      const services = context.services?.supervisedCommands;
      if (!services) {
        throw new ORPCError("NOT_FOUND", { message: "Supervised command not found." });
      }
      const result = services.submitOutput({
        userId: context.session.user.id,
        commandId: input.commandId,
        output: input.output,
        edited: input.output !== null && input.edited,
      });
      if (!result.ok) {
        if (result.error === "conflict") {
          throw new ORPCError("CONFLICT", {
            message: "This command's output was already reviewed or is no longer held.",
          });
        }
        throw new ORPCError("NOT_FOUND", { message: "Supervised command not found." });
      }
      return { status: "exited" as const, outputMode: result.outputMode };
    }),
};
