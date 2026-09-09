import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests boot PGlite -- a real Postgres compiled to WASM -- and run every
    // migration before the first assertion. Under a parallel run on a small CI box that
    // legitimately takes longer than the 10s default, and the whole suite then fails on
    // timing rather than on behaviour. Raising the hook budget does not weaken a single
    // assertion; each test still has the default per-test timeout.
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
