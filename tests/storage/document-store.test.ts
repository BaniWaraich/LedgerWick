import { describe, expect, it } from "vitest";

import { documentKey } from "../../src/storage/keys";
import { FakeDocumentStore } from "./fake-document-store";

const WORKSPACE = "11111111-1111-1111-1111-111111111111";
const KEY = documentKey(WORKSPACE, "documents", "abc", "invoice.pdf");

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("the document store contract", () => {
  it("returns the bytes and content type that were stored", async () => {
    const store = new FakeDocumentStore();
    const bytes = Buffer.from("%PDF-1.7 not really a pdf");

    const stored = await store.put(KEY, bytes, "application/pdf");
    const fetched = await store.get(stored.key);

    expect(fetched).not.toBeNull();
    expect(await readAll(fetched!.stream)).toEqual(bytes);
    expect(fetched!.contentType).toBe("application/pdf");
    expect(fetched!.size).toBe(bytes.byteLength);
  });

  // spec: ADR 0007 — the stored reference is whatever the store says it is, not what we asked for
  it("hands back the key to persist, which need not be the requested one", async () => {
    const store = new FakeDocumentStore();

    const stored = await store.put(KEY, Buffer.from("x"), "application/pdf");

    expect(stored.key).toContain(KEY);
    expect(await store.get(KEY)).toBeNull();
    expect(await store.get(stored.key)).not.toBeNull();
  });

  it("accepts a stream as well as a buffer, so background work can pipe an attachment", async () => {
    const store = new FakeDocumentStore();
    const body = new Response(new Uint8Array(Buffer.from("streamed")))
      .body as ReadableStream<Uint8Array>;

    const stored = await store.put(KEY, body, "text/plain");

    expect((await readAll((await store.get(stored.key))!.stream)).toString()).toBe("streamed");
  });

  it("reports an unknown key as absent rather than throwing", async () => {
    const store = new FakeDocumentStore();

    expect(await store.get("workspaces/nobody/documents/none/x.pdf")).toBeNull();
    expect(await store.head("workspaces/nobody/documents/none/x.pdf")).toBeNull();
  });

  it("describes an object without reading it", async () => {
    const store = new FakeDocumentStore();

    const stored = await store.put(KEY, Buffer.from("1234567890"), "image/png");

    expect(await store.head(stored.key)).toEqual({
      key: stored.key,
      contentType: "image/png",
      size: 10,
    });
  });

  // spec: docs/definition-of-done.md — an uploaded file is never deleted by automated processing
  it("offers no way to delete a document", () => {
    const store = new FakeDocumentStore();

    expect(Object.keys(store)).not.toContain("delete");
    expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
  });
});
