/**
 * The model call identification depends on, as a type.
 *
 * Separated for the reason `src/statements/parse-contracts.ts` gives: `identify.ts` and its
 * tests can then be imported without pulling in a provider, a key, or `server-only`. The
 * implementation lives in `classifier.ts`.
 */

import type { Inference } from "../ai/model";
import type { TransactionJudgements } from "../ai/prompts/classify-transactions.v1";

/** One transaction, as the model is shown it. Numbered, never identified. */
export interface TransactionBrief {
  /** Position in the list. The model answers by this; ids never leave the server. */
  index: number;
  valueDate: string;
  amountMinor: bigint;
  direction: "DEBIT" | "CREDIT";
  currency: string;
  description: string;
  /** Which account it came from, for the "transfer to my own account" judgment. */
  account: string;
}

/** A fact the user has confirmed, flattened for the prompt. identifying-invoices §5 Step 4. */
export interface KnownFact {
  kind: string;
  key: string;
  value: unknown;
}

/**
 * Ask the model what a batch of payments were, and which need a document.
 *
 * Takes the known facts alongside the transactions rather than as a separate pass, because
 * §5 Step 4 puts "check what you already know" before "ask" and the only reliable way to
 * never ask a settled question is for the answer to be present at the moment of asking.
 */
export type ClassifyTransactions = (request: {
  transactions: TransactionBrief[];
  known: KnownFact[];
}) => Promise<Inference<TransactionJudgements>>;
