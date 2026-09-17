# 0009 — The column mapping returns locators, not values

Status: Accepted · 2026-09-17 · Extends `0003-llm-for-structure-not-values.md`

## Context

`0003` draws one line and holds it everywhere it can: **a model identifies structure, code
reads values.** On CSV and text PDF the model maps the file's columns once and deterministic
code then walks every row, so no number a model reported ever reaches the database.

Feature D found a number that rule has nowhere to put.

`upload-statement.md §5` requires an opening balance and a closing balance, and `§7` makes
both a condition of a statement being `VALID` at all — they are the two ends of the equation
`opening + credits − debits = closing`, which is the only automated check the parse gets.

Where a statement carries a running balance column, both fall out of the walk: the closing
balance is the last row's balance, and the opening balance is the first row's balance
adjusted by the first row's own amount. Many statements do not carry one. On those, the two
figures are printed in a summary block above or below the table — `Opening Balance
1,20,000.00` — which is prose, not a column, and no column mapping reaches it.

So the balance check either gets those two numbers from the model, or it does not run.

## Options

**Let the model report the two balances as numbers.** The obvious move, and it quietly
breaks `0003` at the one point where breaking it is least affordable. A misread opening
balance does not fail loudly: it shifts the equation by exactly its own error, and the
statement is reported as a discrepancy of that amount. The user is then told their
statement does not reconcile, by a figure invented by the thing that misread it. Worse, the
inverse happens too — a model that misreads the opening balance in the same direction as a
genuinely missed transaction makes the statement balance, and the check that exists to catch
a dropped row reports success.

**Skip the balance check when there is no balance column.** Honest, and it gives up the only
guardrail the parse has on precisely the statements that have the least structure to begin
with. `0003` already concedes the balance equation is one guardrail and not enough; running
it on some statements and not others makes the validation outcome mean two different things
under one name.

**Have the model point at the numbers, and let code read them.** Chosen.

## Decision

**The column mapping returns `openingBalanceCell` and `closingBalanceCell` as grid
coordinates — a row index and a column index — not as amounts.**

Code reads the cell at each coordinate and parses it with the same `readAmount` that reads
every other figure in the statement, under the same currency and the same decimal separator.

A locator is a structural claim in exactly the sense `0003` means. "The closing balance is
in row 4, column 6" is checkable against the file, has a small answer space, and is wrong in
a way that shows up immediately — the cell either parses as an amount or it does not. "The
closing balance is 1,87,450.00" is an unverifiable assertion that the system has no way to
contradict.

Where the mapping supplies no locators, the balances are derived from the balance column as
described above. Where neither is available, the statement reaches `COMPLETED` with the
validation outcome `DISCREPANCY`, because `§7` requires both balances for `VALID` and the
system does not have them.

## Why

The property worth keeping is not "a model never touches a number". It is that **every
number in the database was read by code from a position in the document**, so that a wrong
number is always traceable to a wrong position and never to a hallucinated digit. Locators
keep that true while extending the balance check to statements that have no balance column.

It also keeps `bank_statements.column_mapping` worth storing. That column exists to debug a
bad parse; a mapping that includes where the balances were found explains a discrepancy far
better than one that only records which column held the debits.

**What is being traded away.** The model now has to count rows and columns in the sample it
is shown, which is a different skill from recognising a column and one that models are less
reliable at. A locator pointing at the wrong cell yields a cell that does not parse as an
amount, or one that does and is the wrong figure. The first is caught here and the balances
fall back to the column or to absent. The second is not distinguishable from a misread
value, and produces a spurious discrepancy — no worse than the option this replaces, and it
fails toward asking a person rather than toward silent acceptance.

This is also a concrete target for `architecture.md §21.2`: locator accuracy is measurable
against the fixtures, separately from column accuracy, and the two may well not move
together.

## Consequences

- `map-statement-columns` returns `{ row, column }` or null for each balance, never a
  number, and its schema is written so a number cannot be returned.
- The scanned path is unaffected. `0003` already accepts that a model reads values there,
  because there is no deterministic layer beneath it; a locator into a grid that does not
  exist would mean nothing.
- Validation has three sources for its balances, in order: the mapping's locators, the
  balance column, then nothing. Which one was used is worth recording with the mapping,
  because a discrepancy is read differently depending on where its ends came from.
- A statement with neither locators nor a balance column is `COMPLETED` / `DISCREPANCY`,
  never `FAILED`. It parsed; it simply cannot be checked, and `upload-statement.md §8` is
  clear that a discrepancy means the system does not trust the result rather than that
  processing failed.
