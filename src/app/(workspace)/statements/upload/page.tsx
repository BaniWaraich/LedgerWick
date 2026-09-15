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

    try {
      const response = await fetch("/api/statements", { method: "POST", body });
      const result = await response.json();

      if (!response.ok) {
        setError(result.error ?? "That upload didn't work. Please try again.");
        setUploading(false);
        return;
      }

      // Processing continues without this page. The batch screen reads it from the
      // database, so leaving or refreshing loses nothing.
      router.push(`/statements/${result.uploadBatchId}`);
    } catch {
      setError("We couldn't reach the server. Please check your connection and try again.");
      setUploading(false);
    }
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
