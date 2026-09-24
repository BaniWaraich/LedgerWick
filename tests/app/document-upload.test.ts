/**
 * The invoice upload route's guards.
 *
 * spec: docs/workflows/manual-invoice-upload.md §3 · docs/definition-of-done.md
 *
 * The route is mostly a funnel into `storeSupportingDocument`, which is tested directly.
 * What is worth testing here is what it refuses before anything is stored, because those
 * are the branches a real upload never exercises and a broken one always does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requireScope = vi.fn();
const storeSupportingDocument = vi.fn();
const send = vi.fn();

vi.mock("../../src/auth/workspace", () => ({ requireScope: () => requireScope() }));
vi.mock("../../src/documents/intake", () => ({
  storeSupportingDocument: (...args: unknown[]) => storeSupportingDocument(...args),
}));
vi.mock("../../src/storage/blob-store", () => ({ getDocumentStore: () => ({}) }));
vi.mock("../../src/inngest/client", () => ({
  inngest: { send: (...args: unknown[]) => send(...args) },
  documentStored: { create: (data: unknown) => data },
}));

const { POST } = await import("../../src/app/api/documents/route");

beforeEach(() => {
  requireScope.mockResolvedValue({ workspaceId: "w1", userId: "u1" });
  storeSupportingDocument.mockResolvedValue({ documentId: "d1", started: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

function upload(fields: Record<string, string | File>): Request {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new Request("http://localhost/api/documents", { method: "POST", body });
}

const pdf = (bytes = 1024, name = "invoice.pdf") =>
  new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

describe("what the route refuses", () => {
  it("refuses a request with no file", async () => {
    const response = await POST(upload({}));

    expect(response.status).toBe(400);
    expect(storeSupportingDocument).not.toHaveBeenCalled();
  });

  it("refuses an empty file", async () => {
    // A zero-byte file is a failed file picker, not a document. Storing it would create a
    // row whose storage_ref resolves to nothing.
    const response = await POST(upload({ file: new File([], "invoice.pdf") }));

    expect(response.status).toBe(400);
    expect(storeSupportingDocument).not.toHaveBeenCalled();
  });

  it("refuses a file too large to read into memory, before storing anything", async () => {
    const response = await POST(upload({ file: pdf(26 * 1024 * 1024, "huge.pdf") }));

    expect(response.status).toBe(413);
    expect(storeSupportingDocument).not.toHaveBeenCalled();
  });

  it("names the file it refused", async () => {
    const response = await POST(upload({ file: pdf(26 * 1024 * 1024, "scan-of-everything.pdf") }));
    const body = await response.json();

    expect(body.error).toContain("scan-of-everything.pdf");
  });
});

describe("what the route accepts", () => {
  it("stores a document and reports the work as queued", async () => {
    const response = await POST(upload({ file: pdf() }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ documentId: "d1", started: true });
  });

  it("passes the chosen payment through as a claim", async () => {
    // Checked against the workspace in intake.ts, which owns the write. The route's job is
    // not to launder it into a fact.
    await POST(upload({ file: pdf(), transactionId: "t1" }));

    const origin = storeSupportingDocument.mock.calls[0][3];
    expect(origin).toEqual({ source: "MANUAL_UPLOAD", canonicalTransactionId: "t1" });
  });

  it("treats an empty payment field as no payment at all", async () => {
    // An untouched hidden input posts "". Sending that on would have intake looking up a
    // transaction whose id is the empty string on every ordinary upload.
    await POST(upload({ file: pdf(), transactionId: "" }));

    const origin = storeSupportingDocument.mock.calls[0][3];
    expect(origin.canonicalTransactionId).toBeUndefined();
  });

  it("says so when the bytes are safe but nothing was queued", async () => {
    // started: false means the file is stored and no workflow was told. The screen says
    // that rather than showing a spinner for work nobody started.
    storeSupportingDocument.mockResolvedValue({ documentId: "d1", started: false });

    const response = await POST(upload({ file: pdf() }));

    expect(response.status).toBe(202);
    expect((await response.json()).started).toBe(false);
  });
});
