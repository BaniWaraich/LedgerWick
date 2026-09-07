import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Only used by commands that connect. Migrations are generated offline.
    url: process.env.DATABASE_URL ?? "",
  },
  // Forward-only: never edit a migration that has been applied (docs/decisions/README.md).
  strict: true,
} satisfies Config;
