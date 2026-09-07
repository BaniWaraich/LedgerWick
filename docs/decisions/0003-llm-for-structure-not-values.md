# 0003 — Statement parsing: LLM for structure, code for values

Status: Accepted · 2026-09-07

Supersedes the per-bank deterministic parser assumption in
`docs/workflows/upload-statement.md` and in decision 0001's slice scoping.

## Context

The original plan assumed hand-written deterministic parsers per bank format.

That does not survive contact with the problem. There are 100+ Indian bank statement
formats, they change without notice, and a hand-written parser cannot address a scanned
statement at all — there is no structured text to write a parser against. Every new bank
would be a new parser, and every silent format change a new bug.

The constraint pulling the other way is that this is a bookkeeping product. The failure
that matters is not a crash; it is a number that is quietly wrong and gets reconciled,
reported, and filed.

## Decision

**An LLM identifies structure. It does not read values where a deterministic path exists.**

### CSV and text-based PDF

The model sees a representative sample — the header row and a few rows, or extracted text
and coordinates for a PDF with embedded text — once per file. It returns a mapping from
the file's columns to a fixed internal vocabulary:

```
date · description · debit · credit · balance
```

Ordinary code then walks the entire document using that mapping. Every amount, every date,
every description is read by deterministic code. The model never sees most of the rows and
never reports a number that reaches the database.

The unit of model output is a small, checkable structural claim, not thousands of values.

### Scanned PDF

Genuinely different, and worth naming as such rather than folding into the above.

No embedded text exists, so OCR or a vision-capable model reads the page directly. The
model *is* reading actual values here. There is no deterministic layer underneath to catch
a misread digit.

Therefore: **a balance mismatch on scanned input is flagged for manual review. It is never
retried into acceptance and never silently accepted.** On the other two paths a mismatch
may indicate a mapping error worth re-deriving; here it indicates the values themselves may
be wrong, and no amount of retrying makes a misread digit correct.

## Why

Structure identification generalizes; value extraction does not need to. A model asked
"which column is the debit column" is answering a question with a small answer space,
verifiable against the rest of the file. A model asked "what are all the amounts" is
producing thousands of unverifiable claims, any one of which can be wrong in a way nobody
notices.

This keeps `docs/architecture.md §2.3` — AI provides inference, not authority — true at the
level where it matters, while still handling formats nobody has written a parser for.

## What this does not solve

The balance check (`opening + credits − debits = closing`) is **one** guardrail, not the
only one required. It catches magnitude errors — a swapped debit/credit mapping shifts the
total and shows up immediately.

It does not catch:

* two errors that cancel out,
* a corrupted or misattributed **date**, which the balance equation is indifferent to,
* a corrupted **description**, likewise.

Both of those matter downstream: reconciliation matches on vendor and date proximity, so a
statement can reconcile perfectly and still produce wrong matches. Validation beyond the
balance check is required and is not designed here.

## Consequences

* No per-bank parser code. One structural inference path plus one deterministic walker.
* The column mapping is a schema-validated model output like any other
  (`docs/architecture.md §9.3`), and a mapping that fails validation fails the statement
  rather than being guessed at.
* Scanned statements carry a higher and explicitly acknowledged error rate, and the product
  should not present their results with the same confidence as the other two paths.
* Fixtures change purpose: they no longer pin down known formats for hand-written parsers,
  they demonstrate that column mapping generalizes across real variety. Awkward statements
  are now the most valuable fixtures rather than edge cases to handle later. See
  `docs/testing-strategy.md`.
* Evaluation now has a first concrete target: mapping accuracy across held-out real
  statements.
