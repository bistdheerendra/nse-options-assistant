import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient | null {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma: PrismaClient | null =
  globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production" && prisma) {
  globalForPrisma.prisma = prisma;
}

export function requirePrisma(): PrismaClient {
  if (!prisma) {
    throw new Error(
      "DATABASE_URL is not set. Configure Postgres (see .env.example) or use the file-backed paper store.",
    );
  }
  return prisma;
}

export function hasDatabase(): boolean {
  return Boolean(prisma);
}
