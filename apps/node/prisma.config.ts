import { defineConfig } from "prisma/config";

// No dotenv dependency: DATABASE_URL is provided by the shell environment
// (docker-compose local dev default matches src/config.ts's fallback).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5433/signalai",
  },
});
