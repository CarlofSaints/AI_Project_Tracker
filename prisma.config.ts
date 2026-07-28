import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma 7 config. The CLI (db push, migrate, studio) reads the connection
// string from here; the running app never does — it gets one through the Neon
// adapter in src/lib/db.ts. Note the CLI does NOT load .env on its own, hence
// the dotenv import above.
//
// Read straight off process.env rather than prisma's env() helper: that helper
// throws on a missing variable, which would break `prisma generate` — a command
// that needs the schema but never touches the database.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
