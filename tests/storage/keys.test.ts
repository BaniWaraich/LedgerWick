import { describe, expect, it } from "vitest";

import { documentKey, sanitizeFilename, workspacePrefix } from "../../src/storage/keys";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("document keys", () => {
  it("puts every document under its own workspace", () => {
    const key = documentKey(WORKSPACE, "statements", "abc", "march.csv");

    expect(key).toBe(`workspaces/${WORKSPACE}/statements/abc/march.csv`);
    expect(key.startsWith(workspacePrefix(WORKSPACE))).toBe(true);
  });

  it("separates statements from supporting documents", () => {
    const statement = documentKey(WORKSPACE, "statements", "abc", "f.pdf");
    const document = documentKey(WORKSPACE, "documents", "abc", "f.pdf");

    expect(statement).not.toBe(document);
  });

  // spec: ADR 0007 — a key is workspace-prefixed, so a filename must not be able to leave it
  it("cannot be walked out of its workspace with a traversal filename", () => {
    const key = documentKey(WORKSPACE, "documents", "abc", `../../${OTHER}/documents/x.pdf`);

    expect(key.startsWith(workspacePrefix(WORKSPACE))).toBe(true);
    expect(key).not.toContain("..");
    expect(key).not.toContain(OTHER);
  });

  it("cannot be walked out of its workspace with an absolute filename", () => {
    const key = documentKey(WORKSPACE, "documents", "abc", "/etc/passwd");

    expect(key).toBe(`workspaces/${WORKSPACE}/documents/abc/passwd`);
  });

  it("strips backslash separators as well as forward ones", () => {
    expect(sanitizeFilename("C:\\Users\\bani\\invoice.pdf")).toBe("invoice.pdf");
  });

  it("never produces an empty final segment", () => {
    expect(sanitizeFilename("")).toBe("document");
    expect(sanitizeFilename("...")).toBe("document");
    expect(sanitizeFilename("/")).toBe("document");
  });

  it("keeps a readable name for a human browsing the store", () => {
    expect(sanitizeFilename("HDFC Statement (Mar 2026).pdf")).toBe("HDFC-Statement-Mar-2026-.pdf");
  });
});
