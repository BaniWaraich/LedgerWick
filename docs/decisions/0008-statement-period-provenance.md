# 0008 — What identification is allowed to decide

Status: Accepted · 2026-09-16

Reverses the absolute period rule in `docs/workflows/upload-statement.md` Step 3.
Extends `0004-data-access.md` Decision 2, which stands.

## Context

Feature C was run against seven real bank statements on a live model for the first time.
Six were identified correctly, including a scanned statement with no text layer. The three
things it got wrong were not model failures so much as rules we had written badly.

**A credit card statement was rejected.** The prompt defined a bank statement as covering a
bank account, so `CREDIT CARD STATEMENT` was correctly classified as not one and failed with
"This doesn't look like a bank statement." But a business charges expenses to a card, and
those transactions need supporting documents exactly like any other.

**A Bank of Ireland account was created denominated in rupees.** `DEFAULT_CURRENCY = "INR"`
was a constant in two files. The document said EURO and carried an IBAN beginning `IE`.

**A statement period was invented.** That same document declares no period — only
"Statement date 21 Apr 2026". The model returned 2025-10-14 to 2026-04-20, which are exactly
the dates of its first and last transactions. The prompt forbids this in terms
("never infer a period from transaction dates you can see"), and the model did it anyway,
because the alternative we had given it was to have its answer thrown away: a statement whose
period could not be determined was `FAILED`.

That last point is the interesting one. The rule created the pressure that broke it.

## Options

**Keep failing statements with no declared period.** Honest, and wrong: the Bank of Ireland
statement is a perfectly good statement with months of real transactions in it, and no amount
of re-uploading will make it declare a period it does not have.

**Let the model report the first and last transaction dates as the period.** Rejected. It is
the model reading values, which `0003` forbids wherever a deterministic path exists — and
here one does, because parsing reads every transaction anyway.

**Let the period be derived during parsing, and record that it was.** Chosen.

## Decision

### 1. A statement is a bank statement or a credit card statement

Identification returns a document kind rather than a boolean. Anything that is neither is
rejected as before. A credit card is bound to a Bank Account whose account kind is
`CREDIT_CARD`; it is not a second concept with its own table, because every relationship in
the domain model would be duplicated verbatim for one.

### 2. The statement period is required at `COMPLETED`, not at `IDENTIFYING`

Identification reports a period **only where the document declares one**, and a statement
that declares none proceeds with no period rather than failing. Parsing derives the range
from the transactions it extracted. Which of the two happened is recorded as the period's
source, `DECLARED` or `DERIVED`.

### 3. Currency is read from the document, and may be inferred only for itself

The model reports an ISO 4217 code. This is the one field it is permitted to infer rather
than read — from an explicit label, then a currency symbol with corroboration, then an
IBAN's country, then the bank's own country. Code validates the answer against a scoped
table of currencies whose minor-unit exponents we know. A currency that cannot be determined
or is not in that table sends the statement to `NEEDS_ACCOUNT`, where the user answers.

An account's currency is set when the account is created and is never rewritten by a later
statement.

## Why

**On the period.** The reason to want a period at all was never deduplication. Overlapping
statements are reconciled by canonical transaction identity — enforced in the database as
`canonical_transactions_identity_idx` over
`(bank_account_id, value_date, amount_minor, direction, description_normalized, occurrence_index)`,
with a bank-supplied reference taking precedence where one exists. Dates play no part.
A period derived from transactions is therefore fully safe against double-counting.

What the period is for is Statement Coverage: answering "which periods has the business not
yet given us?" There, a derived range is weaker than a declared one — if a statement covers
1 April to 30 April but its first transaction falls on the 14th, the derived range
under-claims and a gap report would invent a gap at the edges. That is a false alarm, not a
lost payment, and it is survivable **as long as the report can tell which kind of range it is
looking at**. Hence recording the source rather than quietly treating the two as equal.

**On currency.** `0004` accepted an open edge in as many words: amounts are integer minor
units, and "minor-unit exponents vary by currency". Nothing recorded the exponent, which was
harmless only while every account was INR. It stops being harmless the moment a JPY statement
arrives, because the amount is then wrong by a factor of a hundred rather than merely
mislabelled. Scoping currencies to a table we know the exponents for is what makes the
integer representation safe outside India.

The reason a missing currency asks rather than assumes: because the account's currency is
permanent, an assumption is permanent too. Defaulting to INR would have reproduced the Bank
of Ireland bug through a side door, in a place no one would look.

**What is being traded away.** A second reason a statement can wait for a person. That is a
real cost — `docs/architecture.md` §12C treats every human wait as something to justify — and
it is accepted because `NEEDS_ACCOUNT` already exists for exactly this shape of question, so
the wait is not new machinery, only a new reason to reach it.

## Consequences

- `docs/workflows/upload-statement.md` Step 3 no longer fails a statement for a missing
  period. Step 4 must set `period_source` to `DERIVED` when it supplies one. A statement
  must still not reach `COMPLETED` without a period; parsing is now what enforces that.
- `bank_statements.period_source` is null exactly when `period_start`/`period_end` are null.
- Adding a currency to `src/money/currencies.ts` is a code change with a test, not a
  migration. The table is deliberately short — it is a list of what has been thought about,
  not an attempt at ISO 4217 in full.
- `bank_accounts_identity_idx` deliberately does **not** include the account kind. Two
  accounts are the same account because they share a workspace, a bank and an identifier.
  Including the kind would let one account exist twice under two kinds, and since canonical
  transactions are keyed on `bank_account_id`, a split account would silently defeat
  deduplication — the failure Step 5a calls out as the one that destroys a real payment.
- That same index now matches **case-insensitively**, on `lower(bank_name)` and
  `upper(account_identifier)`. Verifying this change surfaced the split it exists to prevent,
  arriving by a route nobody had considered: two uploads of `axis-bank.pdf` produced
  `AXIS BANK` and `Axis Bank`, and the literal index made two accounts for one. The rule
  lives in `src/statements/account-identity.ts` and must agree with the index exactly — a
  lookup that folds less than the index does would miss, then insert, then throw.

  The folding is deliberately limited to how a document is typeset. `HDFC Bank` and
  `HDFC BANK LIMITED` remain distinct here: deciding they are one institution is entity
  resolution, it has real false positives, and a wrong merge is the expensive direction.
- The prompt is versioned `identify-statement.v2`. v1 is deleted rather than kept alongside:
  `AGENTS.md §7` forbids files nothing uses, and the history is the diff.

## Postscript — the first real evidence for §21.2

`docs/architecture.md` §21.2 defers the model choice to an evaluation. This change produced
the first measurement that evaluation can use, and it is worth recording because it was not
the expected result.

Two of the seven fixtures declare no period: `bank-of-ireland.pdf` ("Statement date 21 Apr
2026" and nothing else) and `sbi.pdf` ("Date : 04-01-24"). Both were run through the v2
prompt above:

| Model | `bank-of-ireland.pdf` | `sbi.pdf` |
| ----- | --------------------- | --------- |
| `anthropic/claude-haiku-4.5` | `2025-10-14` → `2026-04-20`, 3 runs of 3 | `2023-08-01` → `2023-10-15` |
| `anthropic/claude-sonnet-5`  | `null`, 3 runs of 3 | `null` |

In both cases Haiku's answer is the date of the first and last transaction rows in the file —
`sbi.pdf`'s first line is `01-08-23`. Both models read the currency correctly, including the
euro account with no currency label.

So Haiku reads documents well — bank, account, IBAN, currency and account type all correct,
including on a scanned statement with no text layer — but cannot hold the *negative*
instruction not to infer a period from transaction rows. Consistently, on every document
where the instruction binds, not intermittently. Hardening the prompt, adding worked
counter-examples, and removing the pressure that made guessing attractive all failed to move
it.

This is why identification stays on the `DEFAULT_MODEL`. The cost argument for a cheaper
model is real and the difference is not small, but the failure it buys is the specific one
this product cannot have: the invented range is recorded as `DECLARED`, so nothing
downstream can tell a fabricated period from one the bank stated. A guess that announces
itself is survivable. A guess wearing the label that means "verified" is not.

The general lesson for §21.2, which likely outlives this particular pair of models: a model
may be entirely adequate at reading a document and still be unable to decline to answer, and
declining is most of what `docs/architecture.md` §2.3 asks of it. Evaluate the nulls, not
just the values.
