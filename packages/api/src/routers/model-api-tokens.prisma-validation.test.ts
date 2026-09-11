import { createPrismaClient } from "@ws-model-proxy/db/client-factory";
import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "../../../db/prisma/generated/client";
import { buildModelApiTokenAllowlistEntries } from "../lib/model-api-token-allowlist";

const prisma = createPrismaClient("postgresql://u:p@127.0.0.1:1/db");

afterAll(async () => {
  await prisma.$disconnect();
});

describe("model API token allowlist payload", () => {
  it("does not fail Prisma client-side validation for the router's nested create shape", async () => {
    const create = prisma.modelApiToken.create({
      data: {
        userId: "user-id",
        name: "Validation token",
        scopeMode: "ALLOWLIST",
        lookupPrefix: "wsmp_model_validation",
        secretDigest: "validation-digest",
        AllowlistEntries: {
          create: buildModelApiTokenAllowlistEntries({
            directModels: [{ id: "direct-model-id" }],
            modelPools: [{ id: "pool-id" }],
          }),
        },
      },
    });

    const error = await create.catch((reason: unknown) => reason);

    expect(error).not.toBeInstanceOf(Prisma.PrismaClientValidationError);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
