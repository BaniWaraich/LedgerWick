/**
 * A document is written under its workspace's prefix, or not at all.
 *
 * spec: docs/decisions/0007-document-storage.md · docs/phases/phase-1.md §7 B
 *
 * ADR 0007 asks that blob keys be workspace-prefixed. `DocumentStore.put` takes a
 * `DocumentKey` rather than a string, so a writer that hand-rolls a path is a compile
 * error — the same move `WorkspaceScope` makes for the workspace filter.
 *
 * A brand is erased at runtime, so the one way round it is a cast. This test is what
 * stops the cast. It is static for the reason `scope-is-unavoidable.test.ts` is: the
 * failure it guards against is a *future* writer — feature C's upload, feature K's
 * attachment retrieval — and no test written today would think to cover it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { documentKey } from "../../src/storage/keys";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

/** The one file allowed to mint a DocumentKey, because it is the one that builds the prefix. */
const KEY_FACTORY = join(SRC, "storage/keys.ts");

/** A file's code, with comments removed — the brand is discussed in prose in this layer. */
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

/** Everything under src/ except the key factory itself. */
function writerFiles(): string[] {
  return sourceFiles(SRC).filter((path) => path !== KEY_FACTORY);
}

/** `x as DocumentKey`, and the `<DocumentKey>x` spelling of the same escape. */
const FORGED_KEY = /\bas\s+DocumentKey\b|<\s*DocumentKey\s*>/;

describe("document keys", () => {
  it("are minted in exactly one place", () => {
    const offenders = writerFiles()
      .filter((path) => FORGED_KEY.test(codeOf(path)))
      .map((path) => path.slice(ROOT.length + 1));

    // Casting is how the prefix gets skipped without the compiler noticing. A writer that
    // needs a key calls documentKey(); one that cannot is storing something that does not
    // belong to a workspace, which is a design question, not a cast.
    expect(offenders).toEqual([]);
  });

  it("carry the workspace prefix they were branded for", () => {
    const key = documentKeyFor("11111111-1111-1111-1111-111111111111");

    expect(key.startsWith("workspaces/11111111-1111-1111-1111-111111111111/")).toBe(true);
  });

  it("is actually being scanned", () => {
    // Guards the guard: a broken path filter would make the ban above pass vacuously.
    expect(writerFiles().length).toBeGreaterThan(0);
    expect(writerFiles()).not.toContain(KEY_FACTORY);
  });
});

function documentKeyFor(workspaceId: string): string {
  return documentKey(workspaceId, "documents", "seed", "invoice.pdf");
}
