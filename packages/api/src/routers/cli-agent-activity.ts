import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import { z } from "zod";
import { protectedProcedure } from "../index";

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

const cursorSchema = z.string().min(1).max(200);

const listInput = z.object({
  cliDeviceId: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX).default(PAGE_DEFAULT),
  cursor: cursorSchema.optional(),
});

/** Opaque keyset cursor over (createdAt, id): `<epoch ms>.<id>`. */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/.exec(cursor);
  const createdAt = match?.[1] === undefined ? null : new Date(Number(match[1]));
  if (match?.[2] === undefined || createdAt === null || Number.isNaN(createdAt.getTime())) {
    throw new ORPCError("BAD_REQUEST", { message: "Invalid cursor." });
  }
  return { createdAt, id: match[2] };
}

/**
 * Read-only, owner-scoped view of the agent audit log (what MCP agents did on
 * the caller's CLI devices). Metadata only: the log never holds file content,
 * diffs, command output or command text (a command's `path` is a SHA-256 of
 * the command text plus its program name). Also exposed as the MCP tool
 * `forwarder_cli_activity_list`.
 */
export const cliAgentActivityRouter = {
  list: protectedProcedure.input(listInput).handler(async ({ input, context }) => {
    const userId = context.session.user.id;
    const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const rows = await prisma.cliAgentActionEvent.findMany({
      where: {
        // Owner scope first: a device id of another user matches nothing.
        userId,
        ...(input.cliDeviceId === undefined ? {} : { cliDeviceId: input.cliDeviceId }),
        ...(after === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: after.createdAt } },
                { createdAt: after.createdAt, id: { lt: after.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: {
        id: true,
        createdAt: true,
        cliDeviceId: true,
        mcpTokenId: true,
        kind: true,
        path: true,
        etagBefore: true,
        etagAfter: true,
        bytes: true,
        outcome: true,
        reason: true,
        startedAt: true,
        finishedAt: true,
      },
    });
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      events: page.map((row) => ({ ...row, bytes: row.bytes === null ? null : Number(row.bytes) })),
      nextCursor: rows.length > input.limit && last !== undefined ? encodeCursor(last) : null,
    };
  }),
};
