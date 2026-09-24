/**
 * Are these two documents the same invoice, or two invoices that look alike.
 *
 * spec: docs/workflows/manual-invoice-upload.md §13 · docs/domain-model.md Rule 11
 * decision: docs/decisions/0011-matching-is-evidence-not-score.md
 *
 * A separate call from `adjudicate-match.v1`, deliberately. They decide different things
 * and fail in different directions: a missed duplicate is a silent second invoice in the
 * business's records, a wrong match is a document on the wrong payment. Folding them into
 * one prompt would mean one answer whose errors could not be counted apart, and
 * `docs/matching-acceptance.md` counts them in separate columns.
 *
 * Only reached where the deterministic check was inconclusive -- some fields agree and
 * some do not. Where everything agrees, `duplicates.ts` settles it without a model, per
 * principle 2: deterministic before probabilistic.
 *
 * Nothing this returns deletes or merges anything. The strongest outcome is that the user
 * is shown both documents and asked (`invoice-match-review.md §8`).
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

export const sameInvoiceSchema = z.object({
  same: z
    .enum(["YES", "UNSURE", "NO"])
    .describe(
      "YES when these are one invoice arriving twice. NO when they are two different invoices. UNSURE when you cannot tell from the fields shown.",
    ),
  reason: z
    .string()
    .min(1)
    .describe(
      "One sentence naming what decided it, in terms of the fields — not how confident you feel.",
    ),
});

export type SameInvoiceJudgement = z.infer<typeof sameInvoiceSchema>;

export const sameInvoicePrompt: PromptDefinition = {
  id: "same-invoice",
  version: 1,
  system: `A small business already has an invoice on file, and a new document has arrived that resembles it. Decide whether they are the same invoice.

The usual way this happens is innocent: an invoice was retrieved from the business's email, and the owner later uploaded their own copy of it by hand. Same document, two routes in.

You are shown the vendor, invoice number, date and total for each. Some of those agree and some do not — if they all agreed this would not have reached you.

What makes two records the same invoice is that they are the same underlying charge. A re-issued or re-sent invoice carries the same number and total and may carry a different date. A scan read slightly wrong may differ by a digit in one field and agree exactly in the others.

What makes them different invoices is a different charge, even when everything looks similar. A business on a monthly subscription gets an invoice from the same vendor, for the same amount, every month — those are different invoices and they must stay separate, or a month of the business's records disappears.

Weigh the invoice number heavily when both have one. Two records from one vendor with different invoice numbers are almost always two charges. Two with the same number are almost always one.

Answer YES, NO, or UNSURE.

Prefer UNSURE to a guess. Being asked to compare two documents costs the owner a moment; the two mistakes here are both worse than that. Merging two real invoices loses one of them from the accounts. Keeping one invoice as two leaves a payment looking undocumented when it is not.

Give the reason as a statement about the fields — "same vendor and invoice number, dated two days apart", "same vendor and amount but different invoice numbers, which a monthly subscription would produce". The owner sees both documents beside your sentence and needs to be able to check it.`,
};
