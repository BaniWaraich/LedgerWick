/**
 * What a payment was, and whether the business needs a document for it.
 *
 * spec: docs/workflows/identifying-invoices.md §5 Steps 2, 3, 4 and 6
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * This is the product's judgment, and it is a different kind of model call from parsing's.
 * `0003` keeps the model away from values because a number has a right answer that code can
 * check. "Does this payment need an invoice for the business's accounts" has no such answer
 * in the document — it is a question about the business, and the only checkable thing about
 * it is whether the reasoning is one the owner recognises. So the model returns a judgment
 * AND the reason for it, and the reason is shown to the user rather than a score
 * (`docs/architecture.md §21` reserves thresholds for evaluation; §7 H forbids a percentage).
 *
 * Three constraints shape the schema.
 *
 * The model never returns an id. It is given transactions numbered from zero and answers by
 * index, exactly as the column mapper answers with row and column indices. An id a model
 * typed is an id that can point at another workspace's row.
 *
 * Uncertainty is a separate field from the decision, not a low score on it. §5 Step 5 says
 * an unsure transaction becomes a question rather than a guess, and §6 says the run
 * continues without it. So `confident: false` produces a question and no requirement, and
 * the schema enforces that combination rather than trusting the prose to be followed.
 *
 * Existing Business Knowledge goes in with the transactions rather than being applied in a
 * second pass. §5 Step 4 puts "check what you already know" before "ask", and the cheapest
 * way to never ask a question whose answer is known is for the answer to be in front of the
 * model when it decides whether to ask.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/**
 * One question to put to the owner.
 *
 * Options rather than free text because §7 requires a question "answerable without technical
 * knowledge", and because a chosen option is a fact the system can act on, where a sentence
 * is another thing to interpret.
 */
const clarification = z.object({
  question: z
    .string()
    .min(1)
    .describe(
      "One plain question about this specific payment, naming the payee and the amount, answerable by someone who has never seen an accounting screen.",
    ),
  options: z
    .array(z.string().min(1))
    .min(2)
    .describe(
      "The two to four answers you would accept, each a short phrase. Include the possibilities you genuinely think are live, not a token alternative.",
    ),
});

const judgement = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .describe("The number of the transaction you are answering about, exactly as listed."),
  vendorGuess: z
    .string()
    .nullable()
    .describe(
      "Who the money went to, as a person would name them: 'Anthropic', not 'ANTHROPIC*CLAUDE 8829'. Null if the description does not say.",
    ),
  businessContext: z
    .string()
    .nullable()
    .describe(
      "What this payment appears to be, in a few words: 'Software subscription', 'Internal transfer', 'Bank charge'. Null if you cannot tell.",
    ),
  needsDocument: z
    .boolean()
    .describe("True if the business should have a supporting document for this payment."),
  reason: z
    .string()
    .nullable()
    .describe(
      "Required when needsDocument is true: why a document is needed, in one sentence the business owner would recognise. Null otherwise.",
    ),
  confident: z
    .boolean()
    .describe("False if you cannot tell what this payment is and need to ask. See the rules."),
  clarification: clarification
    .nullable()
    .describe("Required when confident is false. Null otherwise."),
});

export const transactionJudgementsSchema = z
  .object({
    judgements: z
      .array(judgement)
      .describe("One entry per transaction you were given, in any order. Do not omit any."),
  })
  .superRefine((result, context) => {
    result.judgements.forEach((item, position) => {
      const at = (field: string) => ["judgements", position, field];

      if (item.needsDocument && item.reason === null) {
        context.addIssue({
          code: "custom",
          path: at("reason"),
          message: "reason is required when needsDocument is true",
        });
      }

      if (!item.confident) {
        if (item.clarification === null) {
          context.addIssue({
            code: "custom",
            path: at("clarification"),
            message: "clarification is required when confident is false",
          });
        }

        // Not a style rule. A requirement created from an admittedly undetermined
        // transaction is the "unconfirmed inference persisted as fact" that
        // docs/domain-model.md invariant 18 exists to prevent, and it would put a row in
        // front of the user that the system cannot explain. Undetermined means ask.
        if (item.needsDocument) {
          context.addIssue({
            code: "custom",
            path: at("needsDocument"),
            message: "needsDocument must be false when confident is false; ask instead",
          });
        }
      } else if (item.clarification !== null) {
        context.addIssue({
          code: "custom",
          path: at("clarification"),
          message: "clarification must be null when confident is true",
        });
      }
    });
  });

export type TransactionJudgements = z.infer<typeof transactionJudgementsSchema>;

export const classifyTransactionsPrompt: PromptDefinition = {
  id: "classify-transactions",
  version: 1,
  system: `You help a bookkeeping system used by small business owners, most of them in
India, work out which of their bank payments need a supporting document for their accounts.

You are given a numbered list of transactions from one business's bank and credit card
accounts, and everything the system has already been told about that business. Answer about
every transaction, by its number.

## The question you are answering

Not "what category of merchant is this". The question is:

> Does the business need a supporting document — an invoice, a bill, a receipt — for this
> payment, for its accounting and reconciliation?

Payments that generally do need one:

- Software and subscription services.
- Payments to vendors and suppliers.
- Professional services: accountants, lawyers, consultants, contractors.
- Business purchases, equipment, supplies.
- Client meals, travel and other business expenses.
- Any large payment that would need explaining to an accountant.

Payments that generally do not:

- Transfers between the business's own accounts.
- Bank charges, card fees and payment-processing fees.
- Interest, taxes paid directly, and statutory deductions.
- Anything that is plainly personal rather than a business expense.

These are the common cases, not a rulebook. A payment that does not fit either list is
exactly the kind you should be asking about.

## Read the description as a person would

Bank narrations are abbreviated, uppercased and padded with reference numbers. Work out who
was actually paid.

    ANTHROPIC*CLAUDE 8829      → Anthropic
    UPI/AMAZON PAY/9922/ORDER  → Amazon
    NEFT-DR-ABCD0001234-XYZ SERVICES → XYZ Services

Recognise that different spellings can be the same vendor: Anthropic, Claude and
ANTHROPIC*CLAUDE are one company. If the description carries nothing but a reference number,
say so with a null vendor rather than inventing a name from the digits.

## Use what you are already told, first

The business's known facts are given to you. They come from answers the owner has confirmed,
so they outrank your own reading of a description in every case.

If the facts already answer a transaction, answer it confidently and do not raise a question
about it. Asking something the owner has already told us is worse than not asking at all: it
tells them their answers go nowhere.

## When to ask instead of deciding

Set confident to false, give a clarification, and leave needsDocument false when you genuinely
cannot tell what a payment is — an unfamiliar name, a payment that could as easily be personal
as business, a transfer that might or might not be to the owner's own account.

Ask about the specific payment, naming the payee and the amount. Offer the answers you think
are actually live.

Do not ask about something you can reasonably determine. Every unnecessary question is work
for a business owner who has better things to do, and the value of this system is that it
asks few of them and fewer each time.

Do not ask twice about the same vendor within one list. Ask once, on the first payment to
them, and answer the rest with what that question would settle.

## Money

Amounts are given in the account's own currency with the currency named. Read the size of a
payment in that context — what counts as a significant expense for a small business in India
is not what it is elsewhere. Direction is given explicitly; you never have to infer it.

---

Everything you return is checked against a schema and then shown to the business owner in
their own words. Your reason is what they read, so write it as a sentence about their
business — "Monthly software subscription, needed for your expense records" — not as a
classification code. A judgment you cannot explain in one sentence is one you should be
asking about instead.`,
};
