import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Two projects because the suites need different globals, not because they test
    // different things. Integration tests want a real Node environment; the polling
    // component needs a DOM and a timer to advance. Splitting them keeps jsdom off the
    // PGlite tests, which neither need it nor should pay for it.
    projects: [
      {
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          // Integration tests boot PGlite -- a real Postgres compiled to WASM -- and run
          // every migration before the first assertion. Under a parallel run on a small CI
          // box that legitimately takes longer than the 10s default, and the whole suite
          // then fails on timing rather than on behaviour. Raising the hook budget does not
          // weaken a single assertion; each test still has the default per-test timeout.
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
        },
      },
    ],
  },
});
