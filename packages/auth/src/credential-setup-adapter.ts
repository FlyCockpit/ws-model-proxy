import prisma, { type Prisma } from "@ws-model-proxy/db";
import { requireOwnerFences } from "@ws-model-proxy/db/capacity-lock-order";
import { BASE_ERROR_CODES, type BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { lockCredentialSetup, RESET_PASSWORD_IDENTIFIER_PREFIX } from "./credential-setup-lock.js";
import { withLockSlot } from "./lock-slots.js";
import { admitResetSpend, deleteResetLinks } from "./password-reset-links.js";
import {
  assertPasswordWriteLocked,
  isResetPasswordWrite,
  passwordWriteLockKey,
} from "./password-write-lock.js";

type Adapter = ReturnType<ReturnType<typeof prismaAdapter>>;

/** One client, one acyclic order. No separate/nested lock connection. */
async function lockActivation(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${passwordWriteLockKey(userId)}))`;
  await lockCredentialSetup(tx, userId);
}

/**
 * Global transactions stay OFF. Only the reset's existing adapter transaction
 * is real. Verification writes use short local transactions;
 * signup locale reads, SMTP and callback network work never sit inside one.
 */
export function createCredentialSetupAdapter(database = prisma) {
  return (options: BetterAuthOptions): Adapter => {
    const make = (client: typeof prisma | Prisma.TransactionClient) =>
      prismaAdapter(client, { provider: "postgresql" })(options);
    const bind = (inner: Adapter, tx?: Prisma.TransactionClient): Adapter => {
      const verificationWrite = async <T>(
        args: Parameters<Adapter["update"]>[0],
        write: (adapter: Adapter) => Promise<T>,
      ): Promise<T> => {
        // Verification can select the user by email or id.
        // Email is immutable. Require scalar, case-sensitive equality before
        // lookup, locks or writes: one selector must identify exactly one user.
        if (
          args.where.length !== 1 ||
          !["id", "email"].includes(args.where[0]!.field) ||
          (args.where[0]!.operator && args.where[0]!.operator !== "eq") ||
          args.where[0]!.mode === "insensitive" ||
          typeof args.where[0]!.value !== "string"
        ) {
          throw new Error("Activation requires an exact user selector");
        }
        const target = await inner.findOne<{ id: string }>({ model: "user", where: args.where });
        if (!target) return write(inner);
        const userId = target.id;
        if (tx) {
          // Reset already holds password-write/credential; never reacquire them.
          await requireOwnerFences(tx, [userId]);
          const result = await write(inner);
          await deleteResetLinks(tx, userId);
          return result;
        }
        return withLockSlot(() =>
          database.$transaction(async (client) => {
            await lockActivation(client, userId);
            const result = await write(make(client));
            await deleteResetLinks(client, userId);
            return result;
          }),
        );
      };
      return {
        ...inner,
        // BA consults this AFTER transaction failure to decide whether queued
        // hooks must run for writes that could not roll back. Advertise the
        // selective reset truth per request, without mutating shared options.
        options: inner.options && {
          ...inner.options,
          adapterConfig: {
            ...inner.options.adapterConfig,
            get transaction() {
              return isResetPasswordWrite() ? inner.transaction : false;
            },
          },
        },
        transaction: async (callback) => {
          if (tx || !isResetPasswordWrite()) return callback(bind(inner, tx));
          // The outer password-write holder reserved this nested slot before
          // opening its lock connection. Hooks flush after this returns/releases.
          return withLockSlot(() =>
            database.$transaction(async (client) => {
              return callback(bind(make(client), client));
            }),
          );
        },
        consumeOne: async (args) => {
          if (args.model.toLowerCase() !== "verification") return inner.consumeOne(args);
          const row = await inner.findOne<{ identifier: string; value: string }>({ ...args });
          if (row?.identifier.startsWith(RESET_PASSWORD_IDENTIFIER_PREFIX)) {
            if (!tx || !isResetPasswordWrite())
              throw new Error("Reset consumption requires its password transaction");
            assertPasswordWriteLocked(row.value);
            if (
              !(await admitResetSpend(
                tx,
                row.identifier.slice(RESET_PASSWORD_IDENTIFIER_PREFIX.length),
                new Date(),
                {
                  activatePrivateInvite:
                    options.emailAndPassword?.requireEmailVerification === false,
                },
              ))
            ) {
              throw APIError.from("BAD_REQUEST", BASE_ERROR_CODES.INVALID_TOKEN);
            }
          }
          return inner.consumeOne(args);
        },
        update: async <T>(args: Parameters<Adapter["update"]>[0]): Promise<T | null> => {
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.update<T>(args);
          return verificationWrite(args, (writer) => writer.update<T>(args));
        },
        updateMany: async (args) => {
          if (args.model.toLowerCase() !== "user" || args.update.emailVerified !== true)
            return inner.updateMany(args);
          return verificationWrite(args, (writer) => writer.updateMany(args));
        },
      };
    };
    return bind(make(database));
  };
}
