/**
 * The Vercel Blob implementation of the document store (ADR 0007).
 *
 * Everything provider-specific lives in this file. The rest of the system sees
 * `DocumentStore` and a string key, which is what makes replacing Blob with an S3 client
 * later "a change in one place" rather than a migration.
 *
 * The SDK is never imported anywhere else.
 */

import "server-only";

import { BlobNotFoundError, get, head, put } from "@vercel/blob";

import type {
  DocumentBody,
  DocumentStore,
  StoredObject,
  StoredObjectBody,
  StoredReference,
} from "./document-store";

/**
 * Private, always.
 *
 * ADR 0007: "Blobs are created with private access. There is no public URL for any
 * document." `get` must name the access mode too, and naming it here rather than at each
 * call site means there is no call that could quietly ask for a public object.
 */
const ACCESS = "private" as const;

/**
 * Credentials come from the environment and are never an argument.
 *
 * The SDK resolves OIDC on Vercel and `BLOB_READ_WRITE_TOKEN` locally. Keeping the token
 * out of this module's signatures is what makes "no credential is logged or returned to
 * the frontend" (`docs/definition-of-done.md`) a property of the type rather than a habit.
 */
class BlobDocumentStore implements DocumentStore {
  async put(
    requestedKey: string,
    body: DocumentBody,
    contentType: string,
  ): Promise<StoredReference> {
    const blob = await put(requestedKey, body, {
      access: ACCESS,
      contentType,
      /*
       * Two uploads of "statement.pdf" into the same workspace must not collide, and the
       * caller does not know whether one already exists. The suffix also makes a key
       * unguessable — defence in depth behind the authorizing route, never a substitute
       * for it.
       */
      addRandomSuffix: true,
    });

    return { key: blob.pathname, contentType: blob.contentType };
  }

  async get(key: string): Promise<StoredObjectBody | null> {
    const result = await get(key, { access: ACCESS });

    // 304 cannot happen: we send no `ifNoneMatch`. Narrowing on 200 is what tells the
    // compiler the stream is non-null, so the case is handled rather than asserted away.
    if (!result || result.statusCode !== 200) return null;

    return {
      key: result.blob.pathname,
      contentType: result.blob.contentType,
      size: result.blob.size,
      stream: result.stream,
    };
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const blob = await head(key);
      return { key: blob.pathname, contentType: blob.contentType, size: blob.size };
    } catch (error) {
      // The SDK throws for a missing blob; the port reports absence as null, because
      // "this document is not in the store" is an ordinary answer, not a failure.
      if (error instanceof BlobNotFoundError) return null;
      throw error;
    }
  }
}

let store: DocumentStore | undefined;

/**
 * The store, constructed on first use.
 *
 * Lazy for the same reason `src/db/client.ts` is lazy: Next evaluates top-level module
 * code at build time, and a build must not fail because a token is absent from the build
 * environment.
 */
export function getDocumentStore(): DocumentStore {
  store ??= new BlobDocumentStore();
  return store;
}
