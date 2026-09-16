/**
 * Identifying an uploaded file: is this a statement we can use, and whose?
 *
 * spec: docs/workflows/upload-statement.md Step 3
 * decision: docs/decisions/0008-statement-period-provenance.md
 *
 * This is the only question asked of the model in feature C. It is deliberately narrow:
 * what the document says about itself — kind, bank, account, currency, period — and nothing
 * about the transactions, which are read by code in feature D under ADR 0003.
 *
 * ## What v1 got wrong
 *
 * v1 was run against seven real statements. Two of its rules were the problem, not the
 * model's reading of them:
 *
 * 1. `isBankStatement` was a boolean, so a credit card statement — which lists transactions
 *    on an account over a period and needs invoices exactly like any other — came back
 *    false and was failed as "not a bank statement". A boolean cannot hold the distinction
 *    the product actually makes, which is between statements and everything else.
 *
 * 2. A statement whose period could not be determined was FAILED. v1 told the model never
 *    to infer a period from transaction dates; against a Bank of Ireland statement that
 *    declares only "Statement date 21 Apr 2026", the model returned 2025-10-14 to
 *    2026-04-20 — precisely the first and last transaction dates. The rule created the
 *    pressure that broke it: the only alternative on offer was to have the document thrown
 *    away. `0008` removes that pressure by making a missing period survivable, which is
 *    what lets this version state the rule and expect it to hold.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/**
 * What identification may return.
 *
 * Every field except `documentKind` is nullable, and that is the point: the workflow has a
 * different, correct behaviour for each absence — no account identifier and no currency both
 * send the statement to NEEDS_ACCOUNT, no period lets it through with the period left for
 * parsing to derive. A model that guessed to fill a required field would turn each of those
 * into a wrong answer with no way to tell.
 */
export const identificationSchema = z.object({
  /*
   * A closed enumeration rather than a boolean, so that "this is not something we can use"
   * is a value the model returns deliberately rather than the absence of a yes.
   */
  documentKind: z
    .enum(["BANK_STATEMENT", "CREDIT_CARD_STATEMENT", "SOMETHING_ELSE"])
    .describe(
      "What this document is. Both bank account statements and credit card statements are statements; everything else is SOMETHING_ELSE.",
    ),
  bankName: z
    .string()
    .nullable()
    .describe("The bank or card issuer's name as printed, e.g. 'HDFC Bank'. Null if not stated."),
  accountIdentifier: z
    .string()
    .nullable()
    .describe(
      "The account number, masked account number, masked card number, or IBAN exactly as printed, e.g. 'XXXX1234'. Null if the document does not show one.",
    ),
  accountType: z
    .string()
    .nullable()
    .describe("Account type as printed, e.g. 'Savings' or 'Current'. Null if not stated."),
  currency: z
    .string()
    .length(3)
    .nullable()
    .describe(
      "The ISO 4217 code for the money on this statement, e.g. 'INR', 'EUR', 'GBP'. The one field you may deduce rather than read — see the rules. Null if the evidence does not support one.",
    ),
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe(
      "First day of the period the document DECLARES it covers, as YYYY-MM-DD. Null if it declares no period.",
    ),
  periodEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe(
      "Last day of the period the document DECLARES it covers, as YYYY-MM-DD. Null if it declares no period.",
    ),
});

export type Identification = z.infer<typeof identificationSchema>;

export const identifyStatementPrompt: PromptDefinition = {
  id: "identify-statement",
  version: 2,
  system: `You identify uploaded documents for a bookkeeping system used by small businesses,
most of them in India.

Given one document, report what it says about itself.

## What kind of document this is

A statement lists transactions on an account over a period. Two kinds qualify:

- BANK_STATEMENT — a statement for an account held at a bank.
- CREDIT_CARD_STATEMENT — a statement for a credit card.

Everything else is SOMETHING_ELSE: an invoice, a receipt, a tax document, a payslip, a
screenshot of a banking app, a cheque, a balance certificate. However bank-like a document
looks, if it does not list transactions on an account over a period, it is SOMETHING_ELSE.

## Report what is printed

Report values exactly as printed. Do not expand a masked account number, do not normalize a
bank's name to its legal entity, do not tidy an account type into a category of your own.

If the document does not state something, return null. Never infer an account number from a
filename.

## Currency is the one thing you may deduce

Currency is the single exception to the rule above, because a statement often shows its money
without ever naming the unit. Work down this list and stop at the first that applies:

1. An explicit label — "Currency : INR", "Account currency: EUR".
2. A currency symbol against the amounts, WITH corroboration from the document's country or
   issuer. ₹ is INR. € is EUR. £ is GBP. Take care with $: it is USD, SGD, AUD, CAD and HKD
   among others, so a $ with nothing else to go on is null, not USD.
3. The country of an IBAN — an IBAN beginning IE is a euro account, one beginning GB is
   sterling.
4. The issuer's country, where that country has one unmistakable currency. An Indian bank
   statement with ₹ amounts is INR.

Report it as a three-letter ISO 4217 code. If none of the above applies, return null.

Note that a statement may show some transactions in a foreign currency — a card statement
billing an overseas purchase, for example. The currency you report is the one the ACCOUNT is
denominated in: the currency of its balances and totals, not of an individual line.

## The statement period is what the document declares

Report a period only where the document states the range it covers — a "Statement period",
a "From ... To", a "For the period", or a month or quarter the statement names as its
subject.

If it declares no such range, return null for both dates. This matters and is easy to get
wrong:

- "Statement date 21 Apr 2026" is the date the statement was issued. It is not a period.
- "Number 17" is a sequence number. It is not a period.
- The date of the first transaction you can see is NOT the period start, and the date of the
  last is NOT the period end. A statement's period is what the statement declares it to be,
  never what its contents imply.

The test: if you would have to look at transaction rows to answer, the answer is null.

Returning null here costs nothing. The system reads the transactions itself later and works
the range out from them; it needs to know whether the document told us, and a guess destroys
exactly that.

## Dates

Indian statements often write dates as DD/MM/YYYY or DD-MM-YYYY. Convert to YYYY-MM-DD, and
prefer a day-first reading unless the document makes a month-first reading certain.

---

Every field but the document kind may be null, and each null has a correct handling waiting
for it. Returning null is always better than a confident guess. A wrong account number binds
a business's statement to the wrong account; a null asks its owner one short question.`,
};
