/**
 * `Prisma.DbNull` (what clears a nullable Json column) without the shared client: importing the
 * package root reads the environment and connects, which pure helpers that only build write
 * data (and their tests) must not need. The same object the client checks for.
 */
import { Prisma } from "../prisma/generated/client";

export const DbNull = Prisma.DbNull;
