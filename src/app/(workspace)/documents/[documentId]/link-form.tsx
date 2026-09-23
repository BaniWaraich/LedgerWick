"use client";

/**
 * Choosing the payment a document belongs to.
 *
 * spec: docs/workflows/manual-invoice-upload.md §12
 *
 * `§12` says what to show: merchant, amount, currency and date — enough for the user to
 * recognise the payment without opening their bank. Nothing is ranked or suggested here,
 * because this is the path taken when the system had nothing to offer, and a suggestion it
 * already failed to make would only be in the way.
 *
 * The full review queue, with candidates and their evidence, is feature H.
 */

import { useActionState } from "react";

import { linkDocumentAction, type LinkFormState } from "../actions";
import styles from "./page.module.css";

export interface LinkableTransaction {
  id: string;
  valueDate: string;
  description: string;
  amount: string;
}

export function LinkForm({
  documentId,
  transactions,
}: {
  documentId: string;
  transactions: LinkableTransaction[];
}) {
  const [state, submit, pending] = useActionState<LinkFormState, FormData>(linkDocumentAction, {});

  if (transactions.length === 0) {
    return (
      <p className={styles.empty}>
        There are no unmatched payments on your statements yet. Upload a bank statement and this
        document can be attached to one of its payments.
      </p>
    );
  }

  return (
    <form className={styles.linkForm} action={submit}>
      <input type="hidden" name="documentId" value={documentId} />

      <fieldset className={styles.choices} disabled={pending}>
        <legend className={styles.legend}>Which payment was this for?</legend>

        {transactions.map((transaction) => (
          <label className={styles.choice} key={transaction.id}>
            <input type="radio" name="transactionId" value={transaction.id} />
            <span className={styles.choiceBody}>
              <span className={styles.choiceName}>{transaction.description}</span>
              <span className={styles.choiceMeta}>
                {transaction.amount} · {transaction.valueDate}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? "Linking…" : "Link to this payment"}
      </button>
    </form>
  );
}
