import type {
  DocumentBody,
  DocumentStore,
  StoredObject,
  StoredObjectBody,
} from "../../src/storage/document-store";

/**
 * A DocumentStore that keeps bytes in a Map.
 *
 * `docs/testing-strategy.md` does not test third-party APIs — we assume Vercel Blob
 * works. What is worth testing is the code around it: the authorizing route, the keys,
 * and that callers persist the key the store returned. All of that is true of this
 * implementation too, and it runs in a millisecond without a token.
 */
export class FakeDocumentStore implements DocumentStore {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  /**
   * Mirrors the real store's suffixing.
   *
   * Vercel Blob is configured with `addRandomSuffix`, so the key that comes back is not
   * the key that went in. The fake does the same thing deterministically, which is what
   * makes "the caller persisted the returned key" a property the tests can catch.
   */
  private static suffix(requestedKey: string, existing: number): string {
    return `${requestedKey}-${existing.toString(36).padStart(4, "0")}`;
  }

  async put(requestedKey: string, body: DocumentBody, contentType: string): Promise<StoredObject> {
    const bytes = Buffer.isBuffer(body)
      ? body
      : Buffer.from(await new Response(body).arrayBuffer());
    const key = FakeDocumentStore.suffix(requestedKey, this.objects.size);

    this.objects.set(key, { bytes, contentType });
    return { key, contentType, size: bytes.byteLength };
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;

    return {
      key,
      contentType: object.contentType,
      size: object.bytes.byteLength,
      stream: new Response(new Uint8Array(object.bytes)).body as ReadableStream<Uint8Array>,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    const object = this.objects.get(key);
    if (!object) return null;

    return { key, contentType: object.contentType, size: object.bytes.byteLength };
  }

  /** Test-only: how many objects exist, so a test can assert nothing was written. */
  get size(): number {
    return this.objects.size;
  }
}
