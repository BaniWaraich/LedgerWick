/**
 * The one way document bytes enter and leave this system.
 *
 * `docs/architecture.md §2.1` makes the original document the source of truth, above
 * anything OCR or a model extracted from it. ADR 0007 chose Vercel Blob to hold those
 * bytes and asked that storage access sit behind a single module, so replacing the
 * provider is a change in one place rather than a change in every workflow.
 *
 * This interface is that module's shape. `src/storage/blob-store.ts` is the real
 * implementation; `tests/storage/fake-document-store.ts` is the one the tests run
 * against, because a network round-trip in a unit test buys nothing.
 *
 * Nothing here touches `next/headers` or a request. That is deliberate and load-bearing:
 * retrieved Gmail attachments are written by an Inngest workflow, not by a user action
 * (ADR 0007), so the store must be callable from background work.
 */

/**
 * What the caller learns from storing an object: the reference to persist.
 *
 * Deliberately narrower than `StoredObject`. The provider's write does not report a size
 * back, and the store will not invent one — a caller that needs it asks `head`.
 */
export interface StoredReference {
  /**
   * The storage reference, as persisted in `storage_ref`.
   *
   * A key, never a URL (ADR 0007). The blob has no public URL to hold even if we wanted
   * to, and this value must never be serialized to the frontend.
   */
  key: string;
  contentType: string;
}

/** What the store knows about an object that already exists. */
export interface StoredObject extends StoredReference {
  size: number;
}

/** An object's bytes, with the metadata needed to serve them. */
export interface StoredObjectBody extends StoredObject {
  stream: ReadableStream<Uint8Array>;
}

/** What may be handed to `put`. Kept narrow — the callers in Phase 1 have bytes. */
export type DocumentBody = Buffer | ReadableStream<Uint8Array>;

/**
 * Read and write document bytes.
 *
 * There is no `delete`. `docs/definition-of-done.md` requires that an uploaded file is
 * never deleted by automated processing, and `architecture.md §2.4` explains why: the
 * manual escape hatch depends on the original surviving every failed automated step. The
 * cheapest way to guarantee that is to give automation no vocabulary for it.
 */
export interface DocumentStore {
  /**
   * Store bytes and return the reference to persist.
   *
   * `requestedKey` is a request, not a promise. The implementation may return a different
   * key, so callers persist `StoredReference.key` and never the key they passed in.
   */
  put(requestedKey: string, body: DocumentBody, contentType: string): Promise<StoredReference>;

  /** The object's bytes, or null if there is no such object. */
  get(key: string): Promise<StoredObjectBody | null>;

  /** The object's metadata without its bytes, or null if there is no such object. */
  head(key: string): Promise<StoredObject | null>;
}
