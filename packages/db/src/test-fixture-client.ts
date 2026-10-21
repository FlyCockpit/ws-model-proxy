import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "../prisma/generated/client";
import { createPrismaClient } from "./client-factory";

/**
 * Test fixtures only. A Prisma client whose every connection carries the
 * session setting `wsmp.fences = ",*,"`, which the graph-write fence triggers
 * accept (schema-hardening.sql, `enforce_graph_write_fence`): fixtures create
 * and remove graph rows directly, without the owner fences writer class M
 * takes (./capacity-lock-order.ts). Production code under test must run on an
 * ordinary client (the shared `@ws-model-proxy/db` client, or
 * `createPrismaClient`), so the triggers keep proving its fences. Fence
 * acquisition itself (`acquireFences`) behaves the same on both clients.
 */
export function createFixturePrismaClient(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get("options");
  url.searchParams.set("options", `${existing ? `${existing} ` : ""}-c wsmp.fences=,*,`);
  // URLSearchParams writes spaces as "+"; spell them %20 (see push-schema.mjs).
  url.search = url.searchParams.toString().replace(/\+/g, "%20");
  return createPrismaClient(url.toString());
}

/**
 * Test fixtures only. An ordinary Prisma client (no fence setting) that counts every SQL
 * statement its connections send, for asserting that a read is batched: the count must not
 * grow with the number of rows it reads (no query per row).
 */
export function createStatementCountingPrismaClient(databaseUrl: string) {
  const counter = { statements: 0 };
  const query = Client.prototype.query;
  class CountingClient extends Client {}
  CountingClient.prototype.query = function countedQuery(this: Client, ...args: unknown[]) {
    counter.statements += 1;
    return Reflect.apply(query, this, args);
  } as unknown as Client["query"];
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, Client: CountingClient }),
  });
  return { client, counter };
}
