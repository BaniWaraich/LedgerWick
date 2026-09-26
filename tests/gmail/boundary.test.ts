/**
 * Mail credentials stay where they are put.
 *
 * spec: docs/workflows/connect-gmail.md §5, §6, §12 · docs/definition-of-done.md "When it
 * touches documents or credentials"
 *
 * `connect-gmail.md §6` asks that tokens never be logged, never reach the frontend, and
 * never be sent to a model. A runtime test can only show that one path behaves; the risk
 * is a path added later. So, like `scope-is-unavoidable.test.ts`, these are static checks
 * over every file under src/, each one a rule a future change would have to break on
 * purpose.
 *
 * What they cannot prove: that a value is never logged under some other name. They make
 * the easy mistakes impossible and the rest visible in review, which is all a test of an
 * absence can do.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const SRC = join(ROOT, "src");

/** A file's code, with comments removed — these names are discussed in prose throughout. */
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

const files = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path),
  code: codeOf(path),
}));

const inGmail = (path: string) => path.startsWith("src/gmail/");

/** Every module specifier a file imports from. */
function imports(code: string): string[] {
  return [...code.matchAll(/\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1] ?? m[2],
  );
}

const reachesModels = (code: string) =>
  imports(code).some((s) => s === "ai" || s.startsWith("@ai-sdk/") || /(^|\/)ai(\/|$)/.test(s));
const reachesGmail = (code: string) => imports(code).some((s) => /(^|\/)gmail(\/|$)/.test(s));

describe("gmail credentials", () => {
  it("are encrypted in exactly one place", () => {
    // `EncryptedToken` is a brand; the cast is the only way to forge one.
    const forged = /\bas\s+EncryptedToken\b|<\s*EncryptedToken\s*>/;
    const offenders = files
      .filter((f) => f.path !== "src/gmail/crypto.ts" && forged.test(f.code))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("are read only inside the gmail module", () => {
    // The column is named in the schema and nowhere outside src/gmail. A page or action
    // reading it is one step from sending it to the browser.
    const offenders = files
      .filter((f) => !inGmail(f.path) && f.path !== "src/db/schema.ts")
      .filter((f) => /encryptedRefreshToken|encrypted_refresh_token/.test(f.code))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("never pass through a module that talks to a model", () => {
    const offenders = files
      .filter(
        (f) =>
          (inGmail(f.path) && reachesModels(f.code)) ||
          (reachesModels(f.code) && reachesGmail(f.code)),
      )
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("are never logged by the module that holds them", () => {
    // No logging in src/gmail at all. Errors leave as `GoogleOAuthError` kinds, which is
    // what a caller logs, and a module with no log statement cannot log a token.
    const logging = /\bconsole\.|\/observability\//;
    const offenders = files
      .filter((f) => inGmail(f.path) && logging.test(f.code))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("never reach a client component", () => {
    // A client component ships to the browser. The gmail module is `server-only`, but a
    // client file importing it would be a build error only if that marker survives.
    const clientFiles = files.filter((f) =>
      /^\s*["']use client["']/m.test(readFileSync(join(ROOT, f.path), "utf8")),
    );
    const offenders = clientFiles.filter((f) => reachesGmail(f.code)).map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("are held by server-only modules", () => {
    const secretHolders = [
      "src/gmail/crypto.ts",
      "src/gmail/oauth.ts",
      "src/gmail/connections.ts",
      "src/gmail/connect-flow.ts",
    ];

    for (const path of secretHolders) {
      expect(readFileSync(join(ROOT, path), "utf8")).toMatch(/^import "server-only";$/m);
    }
  });
});

describe("google's endpoints", () => {
  it("are called from one file", () => {
    // connect-gmail §12: Gmail specifics stay behind one boundary. In feature J that is
    // the OAuth module; feature K's mail access joins it inside src/gmail.
    const google = /googleapis\.com|accounts\.google\.com/;
    const offenders = files
      .filter((f) => f.path !== "src/gmail/oauth.ts" && f.path !== "src/auth/google.ts")
      .filter((f) => google.test(f.code))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("do not yet include the gmail api", () => {
    // Feature J connects; it does not read mail. The first request to the Gmail API is
    // feature K's, and arrives with K's own test that search uses metadata only.
    expect(files.filter((f) => /gmail\.googleapis\.com/.test(f.code)).map((f) => f.path)).toEqual(
      [],
    );
  });
});

describe("these checks", () => {
  it("are actually scanning the gmail module", () => {
    // Guards the guard: a broken path filter would make every test above pass vacuously.
    expect(files.filter((f) => inGmail(f.path)).length).toBeGreaterThanOrEqual(4);
    expect(files.some((f) => reachesModels(f.code))).toBe(true);
  });
});
