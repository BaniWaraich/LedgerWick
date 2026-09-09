# 0007 — Vercel Blob, private, for original documents

Status: Accepted · 2026-09-08 · Closes the file storage OPEN DECISION in `architecture.md §6.1`

## Context

Storage was Supabase Storage because Supabase already supplied the database. Neon offers no
object storage (`0005`), so the choice reopened.

This is load-bearing rather than incidental: `architecture.md §2.1` makes the original
document the source of truth, above anything OCR or an LLM extracted from it. Nothing in
the upload or retrieval workflows can be built until documents have somewhere to live.

## Options

* **Vercel Blob (private)** — no new vendor; the application already deploys to Vercel.
* **Cloudflare R2** — S3-compatible, zero egress, cheaper at volume.
* **AWS S3** — most portable, heaviest setup.

## Decision

**Vercel Blob in private mode**, with document bytes reaching the user only through an
authorized application route.

## Why

The requirements are modest and every candidate meets them; what differs is operational
cost. Vercel Blob adds no account, no IAM configuration, and no second bill, and it is
writable from an Inngest workflow as well as from a request — which matters because
retrieved Gmail attachments are written by background work, not by a user action.

R2 is genuinely cheaper at volume and more portable. That argument gets stronger as
document volume grows, and this decision should be revisited if storage cost becomes
visible. It is not a reason to take on a second vendor for V1.

## Consequences

* Blobs are created with private access. **There is no public URL for any document**, and a
  storage URL is never handed to the frontend (`docs/definition-of-done.md`).
* Documents are served through an authorized route that checks the session and the
  workspace before streaming bytes. The stored reference is a key, not a URL.
* Automated processing never deletes an uploaded file (`architecture.md §2.4` — the manual
  escape hatch depends on the original surviving every failed automated step).
* Blob keys are workspace-prefixed, so a leaked or guessed key is still useless without the
  authorizing route.
* Portability is preserved by keeping storage access behind one module, so replacing Blob
  with an S3 client later is a change in one place.
