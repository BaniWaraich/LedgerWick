import { defineConfig } from "vitest/config";
import path from "path";

/**
 * The bench is not the test suite and must never join it.
 *
 * `vitest.config.ts` includes `tests/**` and runs in CI on every push. Everything in here
 * reads real unredacted statements out of `fixtures/statements/inbox/` and calls a real
 * model with real money, so it gets its own config and its own include glob. Nothing in CI
 * can reach it by accident.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
  test: {
    name: "bench",
    environment: "node",
    include: ["bench/**/*.bench.ts"],
    root: path.resolve(__dirname, ".."),
    // A parse is a PDF extraction plus up to two model calls over a several-hundred-row
    // grid. Minutes, not seconds.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
