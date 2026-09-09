/**
 * The workspace scope cannot be got round.
 *
 * spec: docs/decisions/0004-data-access.md Decision 3 · docs/definition-of-done.md
 *
 * Isolation is enforced in application code, so it is only as strong as the rule that
 * every workspace-scoped read goes through `openWorkspace`. `src/db/workspace-scope.ts`
 * makes that the easy path; this test makes leaving it visible.
 *
 * It is a static check on purpose. A runtime test can only cover the routes that exist
 * today, and the failure it guards against is a route added later that reaches for the
 * unscoped client instead — which no future test would think to write.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../../src");

/**
 * Where authorization is allowed to be written.
 *
 * `src/db` defines the scope. `src/auth` is the one bridge from a session to a scope, and
 * `tests/auth/workspace-resolution.test.ts` attacks it directly.
 */
const AUTHORIZATION_MODULES = ["db", "auth"];

/**
 * A file's code, with comments removed.
 *
 * These names are discussed in prose all over this layer — `proxy.ts` explains that it is
 * deliberately *not* the thing calling `openWorkspace`. Matching raw text would fail on
 * documentation and push the next person to water the rule down instead of obeying it.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(path);
  }
  return acc;
}

/** Everything under src/ that is not itself part of the authorization layer. */
function applicationFiles(): string[] {
  return sourceFiles(SRC).filter((path) => {
    const relative = path.slice(SRC.length + 1);
    return !AUTHORIZATION_MODULES.some((dir) => relative.startsWith(`${dir}/`));
  });
}

describe("application code", () => {
  it("never calls openWorkspace directly", () => {
    const offenders = applicationFiles().filter((path) => /\bopenWorkspace\b/.test(codeOf(path)));

    // It must go through requireScope, which derives userId from the session first.
    expect(offenders).toEqual([]);
  });

  it("never constructs a WorkspaceScope of its own", () => {
    const offenders = applicationFiles().filter((path) =>
      /new\s+WorkspaceScope\b/.test(codeOf(path)),
    );

    expect(offenders).toEqual([]);
  });

  it("never reaches for the unscoped database client", () => {
    const offenders = applicationFiles().filter((path) => /\bgetDb\b/.test(codeOf(path)));

    // getDb is the deliberate escape hatch (0004). It is fine in the authorization layer
    // and in migrations; a page or an action reaching for it has skipped the filter.
    //
    // Workspace creation needs the unscoped client, because a workspace is the boundary
    // rather than something inside one. It belongs beside `listWorkspaces` in
    // src/db/workspace-scope.ts, called from an action -- not inlined into the action.
    // Adding a directory to AUTHORIZATION_MODULES to make this pass is how the rule dies.
    expect(offenders).toEqual([]);
  });

  it("is actually being scanned", () => {
    // Guards the guard: a broken path filter would make every test above pass vacuously.
    expect(applicationFiles().length).toBeGreaterThan(0);
  });
});
