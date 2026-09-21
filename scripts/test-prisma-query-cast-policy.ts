import { findViolations } from "./check-prisma-query-cast-policy.ts";

const db = 'import prisma from "@ws-model-proxy/db";\n';
const rejected = [
  `${db}(await prisma.user.findMany({})) as Row[]`,
  `${db}const rows = await prisma.user.findMany({}); rows as Row[]`,
  `${db}(await prisma.$transaction([prisma.user.findMany({})])) as [Row[]]`,
  `${db}await prisma.$transaction(async (tx) => (await tx.user.findMany({})) as Row[])`,
  `${db}(await prisma.$queryRaw\`SELECT 1\`) as Row[]`,
  `${db}const [rows] = await Promise.all([prisma.user.findMany({})]); rows as Row[]`,
  `${db}const pending = prisma.user.findMany({}); const [rows] = await Promise.all([pending]); rows as Row[]`,
  `${db}const first = prisma.user.findMany({}); const pending = first; const [rows] = await Promise.all([pending]); rows as Row[]`,
  `${db}const first = await prisma.user.findMany({}); const second = first; const third = second; third as Row[]`,
];
const accepted = [
  `${db}await prisma.user.findMany({})`,
  "const rows = await client.user.findMany({}); rows as Row[]",
  "const pending = client.user.findMany({}); const [rows] = await Promise.all([pending]); rows as Row[]",
  `${db}const [row] = await prisma.user.findMany({}); row as Row`,
  `${db}const sdk = {}; (await sdk.user.findMany({})) as Row[]`,
];
for (const [index, source] of rejected.entries())
  if (findViolations(source, `rejected-${index}.ts`).length !== 1)
    throw new Error(`Rejected fixture ${index} was not diagnosed.`);
for (const [index, source] of accepted.entries())
  if (findViolations(source, `accepted-${index}.ts`).length !== 0)
    throw new Error(`Accepted fixture ${index} was diagnosed.`);
console.log(
  `Prisma query-cast policy harness passed (${rejected.length} rejected, ${accepted.length} accepted).`,
);
