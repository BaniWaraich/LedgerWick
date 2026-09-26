"use client";

/**
 * The four things a user can decide, and the evidence for each candidate.
 *
 * spec: docs/workflows/invoice-match-review.md §5, §6, §7
 *
 * One form with several submit buttons, the idiom `questions/answer-form.tsx` established:
 * the pressed button's `name`/`value` arrives in the form data, so choosing a candidate
 * and saying none of them is right are the same submission with a different answer. No
 * separate confirm step, because every one of these is a single decision.
 *
 * `§5`'s layout, and its register: each candidate carries the evidence for it as sentences
 * rather than a score, because "a percentage tells the user nothing they can check". The
 * view model has no number in it to render even by accident.
 *
 * "Upload the document" is a link rather than a button. `§6` says it enters the manual
 * upload workflow pre-bound to this transaction, and that path already works end to end —
 * the query parameter is bound at intake and matching short-circuits on it.
 */

import { useActionState } from "react";

import Link from "next/link";

import type { ReviewCandidate } from "../../../../review/context";
import { resolveRequirementAction, type ReviewFormState } from "./actions";
import styles from "./page.module.css";

export function DecisionForm({
  requirementId,
  transactionId,
  vendorGuess,
  canGeneralize,
  candidates,
  linkable,
}: {
  requirementId: string;
  transactionId: string;
  vendorGuess: string | null;
  canGeneralize: boolean;
  candidates: ReviewCandidate[];
  linkable: { id: string; filename: string; addedOn: string }[];
}) {
  const [state, submit, pending] = useActionState<ReviewFormState, FormData>(
    resolveRequirementAction,
    {},
  );

  return (
    <form className={styles.decisions} action={submit}>
      <input type="hidden" name="requirementId" value={requirementId} />

      {candidates.length > 0 ? (
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>
            {candidates.length === 1 ? "We found this" : `We found ${candidates.length} of these`}
          </h2>

          <ul className={styles.candidates}>
            {candidates.map((candidate) => (
              <li className={styles.candidate} key={candidate.documentId}>
                <div className={styles.candidateHead}>
                  <p className={styles.candidateName}>
                    {candidate.vendorName ?? candidate.filename}
                  </p>
                  <p className={styles.candidateMeta}>
                    {[candidate.invoiceNumber, candidate.invoiceDate].filter(Boolean).join(" · ")}
                  </p>
                  <p className={styles.candidateMeta}>{candidate.filename}</p>
                </div>

                {/*
                  §5's "From: receipts@anthropic.com": where a retrieved document came from, and
                  why that email was looked at. Headers only; retrieval never kept more.
                */}
                {candidate.mail ? (
                  <div className={styles.mail}>
                    <p className={styles.candidateMeta}>From: {candidate.mail.from}</p>
                    <p className={styles.candidateMeta}>
                      {candidate.mail.subject} · found in {candidate.mail.mailbox}
                    </p>
                    <ul className={styles.evidence}>
                      {candidate.mail.evidence.map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {/* §5's "Why they match": the evidence, as sentences, never a score. */}
                <ul className={styles.evidence}>
                  {candidate.evidence.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>

                {candidate.modelReason ? (
                  <p className={styles.reading}>Our reader said: {candidate.modelReason}</p>
                ) : null}

                <div className={styles.candidateActions}>
                  <a
                    className={styles.preview}
                    href={candidate.previewHref}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Preview
                  </a>
                  <button
                    className={styles.primary}
                    type="submit"
                    name="decision"
                    value="CONFIRM"
                    disabled={pending}
                    onClick={(event) => {
                      const form = event.currentTarget.form;
                      if (form) {
                        (form.elements.namedItem("invoiceId") as HTMLInputElement).value =
                          candidate.invoiceId ?? "";
                        (form.elements.namedItem("candidateDocumentId") as HTMLInputElement).value =
                          candidate.invoiceId === null ? candidate.documentId : "";
                      }
                    }}
                  >
                    This is the one
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <input type="hidden" name="invoiceId" defaultValue="" />
          <input type="hidden" name="candidateDocumentId" defaultValue="" />

          <button
            className={styles.secondary}
            type="submit"
            name="decision"
            value="REJECT_ALL"
            disabled={pending}
          >
            {candidates.length === 1 ? "This isn't the one" : "None of these is right"}
          </button>
        </section>
      ) : null}

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>
          {candidates.length > 0 ? "Or do something else" : "What would you like to do?"}
        </h2>

        {/* §6, first outcome. No server code: the link carries the payment through. */}
        <Link className={styles.action} href={`/documents/upload?transaction=${transactionId}`}>
          Upload the document
        </Link>

        {linkable.length > 0 ? (
          <div className={styles.linkExisting}>
            <label className={styles.label} htmlFor="documentId">
              Or link one you have already uploaded
            </label>
            <select className={styles.select} id="documentId" name="documentId" defaultValue="">
              <option value="">Choose a document…</option>
              {linkable.map((document) => (
                <option key={document.id} value={document.id}>
                  {document.filename} · {document.addedOn}
                </option>
              ))}
            </select>
            <button
              className={styles.secondary}
              type="submit"
              name="decision"
              value="LINK_EXISTING"
              disabled={pending}
            >
              Link it
            </button>
          </div>
        ) : null}
      </section>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>Or it needs no document</h2>
        {/* §6: "the single most valuable answer the user can give". */}
        <p className={styles.body}>
          A transfer between your own accounts, a bank fee, or a personal payment.
        </p>

        <div className={styles.breadth}>
          <button
            className={styles.secondary}
            type="submit"
            name="decision"
            value="NOT_REQUIRED_PAYMENT"
            disabled={pending}
          >
            Just this payment
          </button>

          {/*
            §9 says to ask rather than assume how far this goes, and to ask once. With no
            payee to key the fact on there is nothing to generalize over, so the option is
            not offered rather than offered and silently doing nothing.
          */}
          {canGeneralize ? (
            <button
              className={styles.secondary}
              type="submit"
              name="decision"
              value="NOT_REQUIRED_VENDOR"
              disabled={pending}
            >
              Every payment to {vendorGuess}
            </button>
          ) : null}
        </div>
      </section>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
