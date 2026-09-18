/**
 * Putting a business's payments in front of the model.
 *
 * The counterpart to `column-mapper.ts`, kept apart from `identify.ts` for the same reason:
 * the code that decides what to do with a judgment should have no dependency on a model, a
 * provider or a key, so every branch of it can be tested directly.
 *
 * What goes up is a numbered list and the facts the user has confirmed. Ids do not: the
 * model answers by position, so nothing it types can name a row. Amounts go up formatted
 * rather than as minor units, because ₹4,850 is the figure the owner recognises and
 * `485000` is a number they would have to decode -- and the judgment being asked for is
 * about their business, not about the database.
 */

import "server-only";

import { inferStructure } from "../ai/model";
import {
  classifyTransactionsPrompt,
  transactionJudgementsSchema,
} from "../ai/prompts/classify-transactions.v1";
import { currencyFor } from "../money/currencies";
import { formatAmount } from "../money/format";
import type { ClassifyTransactions, KnownFact, TransactionBrief } from "./contracts";

export const classifyTransactions: ClassifyTransactions = async ({ transactions, known }) =>
  inferStructure({
    prompt: classifyTransactionsPrompt,
    schema: transactionJudgementsSchema,
    content: [{ type: "text", text: render(transactions, known) }],
  });

function render(transactions: TransactionBrief[], known: KnownFact[]): string {
  return [
    "## What this business has already told us",
    "",
    known.length === 0
      ? "Nothing yet. This is their first reconciliation, so expect to ask more than usual."
      : known
          .map((fact) => `- ${fact.kind} · ${fact.key}: ${JSON.stringify(fact.value)}`)
          .join("\n"),
    "",
    "## Transactions",
    "",
    ...transactions.map(describe),
  ].join("\n");
}

function describe(transaction: TransactionBrief): string {
  const currency = currencyFor(transaction.currency);
  const amount = currency
    ? formatAmount(transaction.amountMinor, currency)
    : // An account in a currency we do not format is still a payment to judge. The code
      // and the integer are unambiguous, which matters more here than being pretty.
      `${transaction.currency} ${transaction.amountMinor}`;

  return [
    `${transaction.index}. ${transaction.description}`,
    `   ${transaction.direction === "DEBIT" ? "paid out" : "received"} ${amount}`,
    `   on ${transaction.valueDate}, from ${transaction.account}`,
  ].join("\n");
}
