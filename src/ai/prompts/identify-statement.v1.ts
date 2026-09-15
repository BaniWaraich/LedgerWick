/**
 * Identifying an uploaded file: is this a bank statement, and whose?
 *
 * spec: docs/workflows/upload-statement.md Step 3
 *
 * This is the only question asked of the model in feature C. It is deliberately narrow:
 * what the document says about itself — bank, account, period — and nothing about the
 * transactions, which are read by code in feature D under ADR 0003.
 */

import { z } from "zod";

import type { PromptDefinition } from "../model";

/**
 * What identification may return.
 *
 * Every field except `isBankStatement` is nullable, and that is the point: the workflow
 * has a different, correct behaviour for each absence — no period fails the statement, no
 * account identifier sends it to NEEDS_ACCOUNT. A model that guesses to fill a required
 * field would turn both into a wrong answer with no way to tell.
 */
export const identificationSchema = z.object({
  isBankStatement: z
    .boolean()
    .describe("True only if this document is a bank account statement listing transactions."),
  bankName: z
    .string()
    .nullable()
    .describe("The bank's name as printed, e.g. 'HDFC Bank'. Null if not stated."),
  accountIdentifier: z
    .string()
    .nullable()
    .describe(
      "The account number, masked account number, or IBAN exactly as printed, e.g. 'XXXX1234'. Null if the document does not show one.",
    ),
  accountType: z
    .string()
    .nullable()
    .describe("Account type as printed, e.g. 'Savings' or 'Current'. Null if not stated."),
  periodStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("First day the statement covers, as YYYY-MM-DD. Null if not determinable."),
  periodEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .describe("Last day the statement covers, as YYYY-MM-DD. Null if not determinable."),
});

export type Identification = z.infer<typeof identificationSchema>;

export const identifyStatementPrompt: PromptDefinition = {
  id: "identify-statement",
  version: 1,
  system: `You identify uploaded documents for a bookkeeping system used by Indian small businesses.

Given one document, report what it says about itself.

Rules:
- A bank statement lists transactions on a bank account over a period. An invoice, a
  receipt, a tax document or a screenshot is not a bank statement, however bank-like.
- Report values exactly as printed. Do not expand a masked account number, do not
  normalize a bank's name to its legal entity, do not convert a currency.
- If the document does not state something, return null. Never infer an account number
  from a filename, and never infer a period from transaction dates you can see: a
  statement's period is what the statement declares it to be.
- Indian statements often write dates as DD/MM/YYYY or DD-MM-YYYY. Convert to YYYY-MM-DD,
  and prefer a day-first reading unless the document makes a month-first reading certain.

Returning null is always better than a confident guess. A wrong account number binds a
business's statement to the wrong account; a null asks its owner one short question.`,
};
