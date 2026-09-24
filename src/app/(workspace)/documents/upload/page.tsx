"use client";

/**
 * Uploading an invoice.
 *
 * spec: docs/workflows/manual-invoice-upload.md §2, §3
 *
 * Follows `statements/upload` closely, and differs in two ways the workflow asks for.
 *
 * One file, not a batch. A statement upload is a batch because a business exports several
 * months at once; an invoice arrives because the user is looking at one payment.
 *
 * It accepts photographs. `§3` is explicit that a photograph of a physical invoice is a
 * first-class input rather than a degraded PDF, and the accept list and the copy both have
 * to say so or people will not try.
 *
 * `?transaction=` carries the payment through from match review (`§2 C`), which is what
 * makes feature G skip matching for this document. It is passed on as a claim; the server
 * checks it against the workspace.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";

import styles from "./page.module.css";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,.heic,application/pdf,image/*";

interface UploadResponse {
  documentId: string;
}

/**
 * The response body, or null when there isn't one we can read.
 *
 * Kept separate from the fetch for the reason `statements/upload` gives: with both inside
 * one `try`, a server that answered 500 is reported as a server that could not be reached,
 * and the difference between those is an hour of looking in the wrong place.
 */
async function readJson(response: Response): Promise<(UploadResponse & { error?: string }) | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFrom(response: Response, body: { error?: string } | null): string {
  if (body?.error) return body.error;
  return `Something went wrong on our side (error ${response.status}). Please try again.`;
}

function UploadInvoice() {
  const router = useRouter();
  const params = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transactionId = params.get("transaction");

  async function upload() {
    if (file === null || uploading) return;

    setUploading(true);
    setError(null);

    const body = new FormData();
    body.append("file", file);
    if (transactionId) body.append("transactionId", transactionId);

    let response: Response;
    try {
      response = await fetch("/api/documents", { method: "POST", body });
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
      setUploading(false);
      return;
    }

    // A lapsed session arrives as a successful response containing the login page's HTML,
    // because fetch follows the redirect.
    if (response.redirected) {
      setError("Your session expired. Please sign in again and retry the upload.");
      setUploading(false);
      return;
    }

    const result = await readJson(response);

    if (!response.ok || !result) {
      setError(errorFrom(response, result));
      setUploading(false);
      return;
    }

    // Reading and matching continue without this page. The document's own screen reads
    // the outcome from the database, so leaving or refreshing loses nothing.
    router.push(`/documents/${result.documentId}`);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Upload an invoice</h1>
        <p className={styles.subtitle}>
          {transactionId
            ? "We'll attach this document to the payment you chose."
            : "We'll read it and look for the payment it was for."}
        </p>
      </header>

      <div
        className={styles.dropzone}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setFile(event.dataTransfer.files[0] ?? null);
        }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          receipt_long
        </span>
        <p className={styles.dropText}>Drop your invoice here</p>
        <button
          className={styles.browse}
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          Browse files
        </button>
        {/* §3: a photograph is a first-class input, and saying so is what makes people try. */}
        <p className={styles.hint}>A PDF, a scan, or a photo of a paper invoice. Up to 25MB.</p>
        <input
          ref={inputRef}
          className={styles.input}
          type="file"
          name="file"
          accept={ACCEPT}
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
      </div>

      {file ? (
        <ul className={styles.files}>
          <li className={styles.file}>
            <span className="material-symbols-outlined" aria-hidden="true">
              description
            </span>
            <span className={styles.fileName}>{file.name}</span>
            <span className={styles.fileSize}>{Math.ceil(file.size / 1024)} KB</span>
          </li>
        </ul>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <button
        className={styles.submit}
        type="button"
        onClick={upload}
        disabled={file === null || uploading}
      >
        {uploading ? "Uploading…" : "Upload invoice"}
      </button>
    </div>
  );
}

export default function UploadInvoicePage() {
  // useSearchParams needs a Suspense boundary to keep the route statically renderable.
  return (
    <Suspense fallback={null}>
      <UploadInvoice />
    </Suspense>
  );
}
