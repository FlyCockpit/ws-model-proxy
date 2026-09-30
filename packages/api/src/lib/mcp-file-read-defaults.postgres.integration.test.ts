import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SCHEMA_VALIDATION_DATABASE_URL;
if (process.env.REQUIRE_POSTGRES_INTEGRATION === "1" && !databaseUrl) {
  throw new Error("SCHEMA_VALIDATION_DATABASE_URL is required");
}
const integration = databaseUrl ? describe : describe.skip;

integration("read-only MCP file column defaults", () => {
  let prisma: typeof import("@ws-model-proxy/db").default;
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    prisma = (await import("@ws-model-proxy/db")).default;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("defaults both opt-ins off and both reports to null on new rows", async () => {
    const defaults = await prisma.$queryRaw<
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
    const id = crypto.randomUUID();
    const user = await prisma.user.create({
      data: {
        name: "file defaults",
        email: `file-defaults-${id}@example.test`,
        slug: `file-defaults-${id}`,
      },
    });
    const device = await prisma.cliDevice.create({
      data: { userId: user.id, slug: "file-defaults" },
    });
    expect.soft(device.mcpFileRead).toBe(false);
    expect.soft(device.reportedMcpFileRead).toBeNull();
    expect.soft(device.reportedFileRoots).toBeNull();
    const grant = await prisma.mcpGrant.create({
      data: { userId: user.id, clientId: `file-defaults-${id}`, referenceId: "file-defaults" },
    });
    const token = await prisma.mcpPersonalToken.create({
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
    expect.soft(token.allowCliFileRead).toBe(false);
    const updatedDevice = await prisma.cliDevice.update({
      where: { id: device.id },
      data: { mcpFileRead: true, reportedMcpFileRead: true, reportedFileRoots: true },
    });
    expect(updatedDevice).toMatchObject({
      mcpFileRead: true,
      reportedMcpFileRead: true,
      reportedFileRoots: true,
    });
    const updatedToken = await prisma.mcpPersonalToken.update({
      where: { id: token.id },
      data: { allowCliFileRead: true },
    });
    expect(updatedToken.allowCliFileRead).toBe(true);
  });
});
