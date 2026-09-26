/**
 * What a requirement's retrieval came to.
 *
 * spec: docs/workflows/retrieve-invoices.md §16, §17, §20 · docs/state-machines.md §2
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 *
 * Pure. It reads what the searches found and says what happens next, and it never writes.
 */

import type { mailboxSearchOutcomeEnum } from "../db/schema";

export type MailboxOutcome = (typeof mailboxSearchOutcomeEnum.enumValues)[number];

export type AfterSearch = "FETCH" | "NOT_FOUND" | "BLOCKED";

/**
 * After searching, before anything is downloaded.
 *
 * - Something worth downloading: download it, and let the documents decide.
 * - Nothing, and a mailbox could not be searched: `BLOCKED`. We did not look everywhere,
 *   so "not found" would be a claim we cannot make, and `retrieve-invoices.md §17` is
 *   explicit that an authorization problem is not a "no document found".
 * - Nothing, with every mailbox searched: `NOT_FOUND`. A business outcome, not a failure
 *   (`§16`).
 *
 * A `FAILED` mailbox never reaches here: its search threw, and the workflow retries it.
 */
export function afterSearch(input: {
  readonly mailboxes: readonly MailboxOutcome[];
  readonly selected: number;
}): AfterSearch {
  if (input.selected > 0) return "FETCH";
  return input.mailboxes.some((outcome) => outcome !== "COMPLETED") ? "BLOCKED" : "NOT_FOUND";
}
