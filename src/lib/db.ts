import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@/generated/prisma/client";

// Prisma 7 requires a driver adapter — there is no built-in engine connection
// any more. PrismaNeon speaks Neon's serverless protocol, which is what we want
// on Vercel Functions.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const client = new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });

  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

/**
 * Connect lazily, on first query rather than on import.
 *
 * `next build` loads every route module to analyse it, so a client constructed
 * at module scope would demand DATABASE_URL at build time — and fail any build
 * that doesn't have the database wired up yet. The proxy defers that to the
 * first actual query, which only ever happens at request time.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const client = globalForPrisma.prisma ?? createClient();
    return Reflect.get(client, property, receiver);
  },
});
