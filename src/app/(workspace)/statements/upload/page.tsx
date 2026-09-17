"use client";

/**
 * Choosing statements to upload.
 *
 * Follows wireframes/upload_statement. The wireframe says "PDF only"; the workflow says
 * PDF, CSV and Excel; phase 1 scopes parsing to CSV and PDF. The copy here states what
 * the system actually accepts, which is the narrowest of the three (see
 * `src/statements/intake.ts`).
 *
 * The files go to `/api/statements`, not to storage directly, so no write credential and
 * no storage key ever reaches this page (ADR 0007).
 */

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import styles from "./page.module.css";

const ACCEPT = ".pdf,.csv,application/pdf,text/csv";

/** What the upload route returns when it worked. */
interface UploadResponse {
  uploadBatchId: string;
}

/**
 * The response body, or null when there isn't one we can read.
 *
 * A route that threw returns Next's HTML error page rather than JSON, and parsing that
 * throws. Keeping the parse separate from the fetch is the whole point: with both inside one
 * `try`, a server that answered with a 500 was reported as a server that could not be
 * reached, and the difference between those two is an hour of looking in the wrong place.
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
  // The server answered and we could not read what it said. Saying so, with the status, is
  // more use than a generic apology -- to the person reading it and to whoever they tell.
  return `Something went wrong on our side (error ${response.status}). Please try again.`;
}

export default function UploadStatementPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (files.length === 0 || uploading) return;

    setUploading(true);
    setError(null);

    const body = new FormData();
    for (const file of files) body.append("files", file);

    let response: Response;
    try {
      response = await fetch("/api/statements", { method: "POST", body });
    } catch {
      // Only a genuine network failure reaches here now. Everything the server said,
      // however badly, is handled below.
      setError("We couldn't reach the server. Please check your connection and try again.");
      setUploading(false);
      return;
    }

    // The route redirects an unauthenticated request to the login page, and `fetch` follows
    // redirects — so a lapsed session arrives here as a perfectly successful response
    // containing HTML.
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

    // Processing continues without this page. The batch screen reads it from the
    // database, so leaving or refreshing loses nothing.
    router.push(`/statements/${result.uploadBatchId}`);
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Upload your bank statements</h1>
        <p className={styles.subtitle}>
          We read them to work out which payments need a supporting document. Upload as many as you
          like — each one is processed on its own.
        </p>
      </header>

      <div
        className={styles.dropzone}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          setFiles(Array.from(event.dataTransfer.files));
        }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          cloud_upload
        </span>
        <p className={styles.dropText}>Drop your statements here</p>
        <button
          className={styles.browse}
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
        >
          Browse files
        </button>
        <p className={styles.hint}>PDF or CSV, up to 25MB each.</p>
        <input
          ref={inputRef}
          className={styles.input}
          type="file"
          name="files"
          accept={ACCEPT}
          multiple
          onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
        />
      </div>

      {files.length > 0 ? (
        <ul className={styles.files}>
          {files.map((file) => (
            <li className={styles.file} key={`${file.name}-${file.size}`}>
              <span className="material-symbols-outlined" aria-hidden="true">
                description
              </span>
              <span className={styles.fileName}>{file.name}</span>
              <span className={styles.fileSize}>{Math.ceil(file.size / 1024)} KB</span>
            </li>
          ))}
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
        disabled={files.length === 0 || uploading}
      >
        {uploading ? "Uploading…" : "Upload and continue"}
      </button>
    </div>
  );
}
