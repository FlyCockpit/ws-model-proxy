import { createFixturePrismaClient } from "@ws-model-proxy/db/test-fixture-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required");
}
const integration = databaseUrl ? describe : describe.skip;

integration("read-only MCP file column defaults", () => {
  let prisma: ReturnType<typeof createFixturePrismaClient> | undefined;

  beforeAll(async () => {
    if (!databaseUrl) return;
    process.env.DATABASE_URL = databaseUrl;
    prisma = createFixturePrismaClient(databaseUrl);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function db(): ReturnType<typeof createFixturePrismaClient> {
    if (!prisma) throw new Error("fixture client unavailable");
    return prisma;
  }

  it("defaults both opt-ins off and both reports to null on new rows", async () => {
    const defaults = await db().$queryRaw<
      { table_name: string; column_name: string; column_default: string | null }[]
    >`
      SELECT table_name, column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND (
        (table_name = 'cli_device' AND column_name IN ('mcpFileRead', 'reportedMcpFileRead', 'reportedFileRoots'))
        OR (table_name = 'mcp_personal_token' AND column_name = 'allowCliFileRead')
      ) ORDER BY table_name, column_name
    `;
    expect(defaults).toEqual([
      { table_name: "cli_device", column_name: "mcpFileRead", column_default: "false" },
      { table_name: "cli_device", column_name: "reportedFileRoots", column_default: null },
      { table_name: "cli_device", column_name: "reportedMcpFileRead", column_default: null },
      {
        table_name: "mcp_personal_token",
        column_name: "allowCliFileRead",
        column_default: "false",
      },
    ]);
  });

  it("writes the defaults onto real rows and accepts explicit values", async () => {
    const id = crypto.randomUUID();
    const user = await db().user.create({
      data: {
        name: "file defaults",
        email: `file-defaults-${id}@example.test`,
        slug: `file-defaults-${id}`,
      },
    });
    // Created without the grant or report fields: the catalog defaults must land.
    const device = await db().cliDevice.create({
      data: { userId: user.id, slug: `file-defaults-${id}` },
    });
    expect(device.mcpFileRead).toBe(false);
    expect(device.reportedMcpFileRead).toBeNull();
    expect(device.reportedFileRoots).toBeNull();

    const grant = await db().mcpGrant.create({
      data: { userId: user.id, clientId: `pat:${id}`, referenceId: `file-defaults-${id}` },
    });
    const token = await db().mcpPersonalToken.create({
      data: {
        id,
        userId: user.id,
        grantId: grant.id,
        name: "file defaults",
        lookupPrefix: id,
        secretDigest: `default-fixture-${id}`,
        scopes: ["mcp:read"],
      },
    });
    expect(token.allowCliFileRead).toBe(false);

    // Explicit values round-trip, so the defaults are real defaults and not
    // an immutable read-only column.
    const updatedDevice = await db().cliDevice.update({
      where: { id: device.id },
      data: { mcpFileRead: true, reportedMcpFileRead: true, reportedFileRoots: true },
    });
    expect(updatedDevice).toMatchObject({
      mcpFileRead: true,
      reportedMcpFileRead: true,
      reportedFileRoots: true,
    });
    const updatedToken = await db().mcpPersonalToken.update({
      where: { id: token.id },
      data: { allowCliFileRead: true },
    });
    expect(updatedToken.allowCliFileRead).toBe(true);
  });
});
