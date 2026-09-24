"use client";

/**
 * Two documents that may be the same invoice.
 *
 * spec: docs/workflows/invoice-match-review.md §8
 *
 * A different question from the rest of the screen -- "are these the same invoice" rather
 * than "which payment" -- so it sits above the candidates and says so in its heading.
 * Answering it changes what the candidate list means, which is why it goes first.
 *
 * Both sides are shown for every field, agreements and disagreements alike. §8's layout is
 * two columns for exactly that reason: the user is being asked to read, and a panel that
 * showed only what matched would be arguing rather than informing.
 */

import { useActionState } from "react";

import type { DuplicateComparison } from "../../../../review/duplicates";
import { resolveRequirementAction, type ReviewFormState } from "./actions";
import styles from "./page.module.css";

export function DuplicatePanel({
  requirementId,
  duplicate,
}: {
  requirementId: string;
  duplicate: DuplicateComparison;
}) {
  const [state, submit, pending] = useActionState<ReviewFormState, FormData>(
    resolveRequirementAction,
    {},
  );

  return (
    <form className={styles.card} action={submit}>
      <input type="hidden" name="requirementId" value={requirementId} />
      <input type="hidden" name="duplicateInvoiceId" value={duplicate.incomingInvoiceId} />

      {/* §8's sentence, when the fields say so plainly. */}
      <h2 className={styles.cardTitle}>This appears to be the same invoice we already found</h2>
      {duplicate.reason ? <p className={styles.body}>{duplicate.reason}</p> : null}

      <table className={styles.comparison}>
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">Already on file</th>
            <th scope="col">Just uploaded</th>
          </tr>
        </thead>
        <tbody>
          {duplicate.fields.map((field) => (
            <tr key={field.field} data-agrees={field.agrees === null ? "unknown" : field.agrees}>
              <th scope="row">{field.field}</th>
              <td>{field.existing ?? "—"}</td>
              <td>{field.incoming ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {duplicate.existingDocumentId && duplicate.incomingDocumentId ? (
        <fieldset className={styles.choices} disabled={pending}>
          {/* §8: "the user chooses which is primary". Nothing is deleted either way. */}
          <legend className={styles.label}>If they are the same, which copy should we keep?</legend>

          <label className={styles.choice}>
            <input
              type="radio"
              name="primaryDocumentId"
              value={duplicate.existingDocumentId}
              defaultChecked
            />
            <span>The one already on file</span>
          </label>

          <label className={styles.choice}>
            <input type="radio" name="primaryDocumentId" value={duplicate.incomingDocumentId} />
            <span>The one just uploaded</span>
          </label>
        </fieldset>
      ) : null}

      <div className={styles.breadth}>
        <button
          className={styles.primary}
          type="submit"
          name="decision"
          value="SAME_INVOICE"
          disabled={pending}
        >
          Same invoice — keep one
        </button>
        <button
          className={styles.secondary}
          type="submit"
          name="decision"
          value="DIFFERENT_INVOICES"
          disabled={pending}
        >
          Different invoices
        </button>
      </div>

      <p className={styles.body}>Both files are kept whichever you choose.</p>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
