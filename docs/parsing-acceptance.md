# When statement parsing is done

## Why this document exists

Feature D had a completion bar before this document, in `docs/phases/phase-1.md §7 D`, and
466 passing tests satisfied almost all of it while the parser was dropping 71% of a real
bank statement. The bar was not wrong so much as aimed at the wrong thing.

Parsing has two kinds of correctness and they need different evidence.

**Logical correctness.** The balance equation, the canonical identity rule, the state
machine, the handling of a mapping that fails its schema. These are decidable. A test
proves one, it passes or it fails, and a green suite is real evidence.

**Generalisation.** `docs/decisions/0003` stakes the entire no-per-bank-parser design on a
single claim: that a model can map the columns of a statement nobody has written a parser
for. That is a statistical property of a population of documents, and no finite suite of
tests demonstrates it. The only evidence is how often the system is wrong about a statement
it has never seen.

`docs/testing-strategy.md` already draws this line — tests pass or fail, evals produce a
score that moves — but the phase document asked only that mapping accuracy be "measured at
least once". Measuring once is an activity, not a threshold. This document supplies the
threshold.

---

## The measurement that matters

**First-attempt pass rate on unseen statements.** Of the statements nobody had looked at
before running them, how many parsed correctly with no code change?

Everything else is downstream of this number. A test suite that is green says the bugs we
have already found stay fixed. Only this says whether the next statement a user uploads
will work.

### A statement gets one first impression

This is the rule that makes the number mean anything, and it is easy to lose.

Every statement so far has been consumed as a bug report: run it, watch it fail, fix the
code, move on. That turns the document into training data. The code has since been shaped
by it, so from then on it can only ever demonstrate that we have not regressed — never that
we generalise.

So: **run a new statement blind, record the outcome, and only then fix anything.** The
recorded outcome is the sole honest evidence that document will ever give about
generalisation. Fixing first and recording afterwards destroys it, permanently and
invisibly.

Every statement is logged below, whatever happened, before any fix.

---

## What "passed" means for one statement

A statement that reconciles can still be wrong: `0003` is explicit that the balance equation
is blind to a corrupted date and a corrupted description, and a statement can balance
perfectly while its narration is empty. So the per-document bar is all of:

- **Every transaction is present.** The line count matches a human count of the document.
- **It reconciles**, or its discrepancy has an identified, genuine cause — a typo in the
  document, a figure the document does not print. "It came out as a discrepancy" is not a
  pass.
- **Descriptions are whole.** None empty, none truncated, none carrying text from a column
  that is not the narration. Feature E has nothing to reason about otherwise.
- **Dates are right**, checked at both ends of the period and across any month boundary.
- **Re-uploading it produces zero new canonical transactions.**

Anything less is a failure for the purposes of the log, however close it came.

---

## Binary invariants

These are not thresholds. A single failure blocks release, and no volume of passing
statements offsets one.

- No false merge: two distinct payments never share a canonical transaction.
- Re-uploading a processed statement produces zero new canonical transactions.
- Overlapping statements produce one canonical transaction with two statement lines.
- No statement reaches `COMPLETED` without a period.
- Every statement terminates in `COMPLETED` or `FAILED` — none is left mid-flight.
- A scanned-input mismatch is never retried into acceptance (`0003`).
- A mapping that fails schema validation fails the statement rather than being guessed at.

A missed duplicate is visible to the user as a repeated row. A false merge silently destroys
a real payment, which is why it sits here rather than in a threshold.

---

## Measured thresholds

Across the fixture corpus, recorded with the run that produced them.

| Measure | Bar | Why there |
| --- | --- | --- |
| Row recall, CSV and text PDF | **100%** | A dropped row is a lost payment. Bank of Ireland lost 238 and still produced a plausible balance difference, so the balance check cannot be relied on to notice. |
| Row recall, scanned | **≥ 98%** | `0003` accepts a higher error rate where a model reads values with nothing deterministic beneath it. |
| Mapping accuracy, first attempt | **≥ 90%** | Every column, the amount shape, and the date order correct. The re-derive exists for the remainder. |
| Rows with a usable description | **≥ 99%** | Feature E matches on vendor. ICICI once produced 80% blank and still reconciled. |
| Balance reconciliation | **100%** of statements whose own figures are internally consistent | A document with contradictory figures of its own is a discrepancy, correctly. |

---

## The release bar

**Feature D is done when six consecutive unseen statements parse correctly on first
attempt, with no code change between them.**

Not a count of statements tested. A count of statements that taught us nothing — which is
the only observable sign that the discovery rate has fallen, and therefore the only evidence
that the next one is likely to work.

A failure resets the streak. That is the point: it means the population still holds
surprises, and six in a row is the claim that it mostly does not.

At the failure rate seen so far this implies a corpus well beyond the minimum below. That is
the honest cost of the claim `0003` makes.

### Corpus minimum

None of the above means anything measured over three documents from two banks.

- **≥ 12 statements**, across **≥ 6 distinct banks**
- **all three input paths**, with at least **2 CSV** and **2 scanned**
- redacted and checked in under `fixtures/statements/`, per `docs/testing-strategy.md`

As of 2026-09-17: 8 documents in hand, **0 redacted**, **0 CSV**. Tracked in BAN-136, and
the redaction is manual by rule.

### Every failure donates a fixture

Already the rule in `docs/testing-strategy.md`, and it is the ratchet that makes the streak
mean something: a statement that fails becomes a permanent test, so the same surprise cannot
be counted as new twice.

---

## The log

Every statement's first impression, recorded before any fix. This is the eval artifact;
`docs/architecture.md §21` asks for exactly this kind of record rather than an intuition.

| # | Statement | Path | First attempt | What it taught |
| --- | --- | --- | --- | --- |
| 1 | Central Bank of India | scanned | ✗ failed outright | pdf.js detaches the buffer it is handed, so the vision model was sent a zero-byte document |
| 2 | ICICI Bank | text PDF | ✗ reconciled, 80% of descriptions blank | A narration is a cell taller than the figures beside it, not a row |
| 3 | Bank of Ireland | text PDF | ✗ 108 of 349 transactions | A statement prints the date once a day, not once a transaction. Relaxing that let an IBAN and an IFSC code into the amount columns |
| 4 | Bank Statement Example | text PDF | ✗ zero transactions | A date may leave its year to the header. A document's own figures may be mistyped |

**First-attempt pass rate: 0 of 4. Current streak: 0.**

Four documents, nine defects, none of which the test suite could have found — every grid in
it was one tidy row per transaction, with a full date and well-formed numbers. That is the
argument for this document, and for the corpus being a completion criterion rather than a
nicety.
