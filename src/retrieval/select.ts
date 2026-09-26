/**
 * Which messages to download.
 *
 * spec: docs/workflows/retrieve-invoices.md §9, §13 · docs/workflows/connect-gmail.md §5
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Pure and deterministic. Downloading is the point where retrieval stops looking at
 * headers and asks for a message's full contents (`connect-gmail.md §5`: "only to fetch an
 * attachment on a message that has already been selected as a candidate"). So the choice
 * is made here, from headers alone, before any full-format request exists to be made.
 *
 * ## Leaning towards recall, on purpose
 *
 * Selecting a message costs a download and a model call. Selecting the wrong one costs
 * nothing worse: the document is judged on its own contents by matching, and the settle
 * step's conjunction decides whether anything is linked. A missed message, on the other
 * hand, is an invoice the user has to find by hand. So any message whose headers point at
 * the vendor or at an invoice is selected, up to the cap.
 */

import { hasSignal, strength, type EmailEvidence } from "./evidence";
import { MAX_MESSAGES_FETCHED } from "./thresholds";

export interface SelectableCandidate {
  readonly id: string;
  readonly gmailConnectionId: string;
  readonly gmailMessageId: string;
  readonly rfc822MessageId: string | null;
  readonly evidence: readonly EmailEvidence[];
}

export interface Selection {
  /** The candidate rows chosen for download. */
  readonly selected: ReadonlySet<string>;
  /** Every message with a signal fitted under the cap. False means some were left out. */
  readonly exhaustive: boolean;
}

/**
 * One key per distinct message.
 *
 * The same mail delivered to two connected mailboxes has two Gmail ids and one RFC 822
 * Message-ID. Counting it once keeps a business with two mailboxes from spending two of
 * its five downloads on one invoice. Both rows are still selected, so both provenances
 * are kept.
 */
function messageKey(candidate: SelectableCandidate): string {
  return candidate.rfc822MessageId ?? `${candidate.gmailConnectionId}:${candidate.gmailMessageId}`;
}

export function selectForFetching(candidates: readonly SelectableCandidate[]): Selection {
  const withSignal = candidates.filter((c) => hasSignal(c.evidence));

  /*
   * Strongest first, and ties broken on the message key rather than on arrival order, so
   * that a retry chooses exactly what the first attempt chose.
   */
  const ordered = [...withSignal].sort((a, b) => {
    const diff = strength(b.evidence) - strength(a.evidence);
    return diff !== 0 ? diff : messageKey(a).localeCompare(messageKey(b));
  });

  const chosenMessages = new Set<string>();
  const selected = new Set<string>();
  let exhaustive = true;

  for (const candidate of ordered) {
    const key = messageKey(candidate);
    if (!chosenMessages.has(key)) {
      if (chosenMessages.size >= MAX_MESSAGES_FETCHED) {
        exhaustive = false;
        continue;
      }
      chosenMessages.add(key);
    }
    selected.add(candidate.id);
  }

  return { selected, exhaustive };
}
