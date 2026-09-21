# When document understanding is done

## Why this document exists

`docs/parsing-acceptance.md` was written after the fact. Feature D had a completion bar,
466 passing tests satisfied almost all of it, and the parser was dropping 71% of a real bank
statement throughout. This one is written before the fact, for the same reason and a
stronger one.

Feature F's bar in `docs/phases/phase-1.md §7 F` ends with "OCR and model choices are made
against fixtures, with the result recorded." That is the exact formulation
`parsing-acceptance.md` exists to replace — measuring once is an activity, not a threshold.

And F is the harder case. Parsing has the balance equation: read a statement wrong enough
and `opening + credits − debits = closing` stops working, which is a weak check but a real
one, and it is automatic. **An invoice has nothing.** One page, one total, no second figure
to check the first against, no arithmetic of any kind. `docs/decisions/0010` is explicit
about the limit of what code can do here:

> Locators catch misreadings. They do nothing about mislocations.

A model that confidently transcribes the subtotal into `total` produces a perfectly
parseable span, a valid `invoices` row, and a wrong number in someone's accounts. Nothing in
the test suite can ever see that. Only a person holding the document beside the output can.

So the evidence for feature F is a log kept by a human, and this document is that log.

---

## The measurement that matters

**First-attempt pass rate on unseen invoices.** Of the documents nobody had looked at before
running them, how many were understood correctly with no code change?

A green test suite says the mistakes we have already found stay fixed. Only this says
whether the next invoice a user uploads will work.

### A document gets one first impression

The rule that makes the number mean anything, and the easiest one to lose.

Every document consumed as a bug report — run it, watch it fail, fix the code — becomes
training data. The code has since been shaped by it, so from then on it can only demonstrate
that we have not regressed, never that we generalise.

**Run a new invoice blind, record the outcome, and only then fix anything.** Fixing first and
recording afterwards destroys the only honest evidence that document will ever give,
permanently and invisibly. `BAN-152` is the standing prompt.

---

## What "passed" means for one document

Stricter than "it did not error", and deliberately so. A document passes only if **all** of:

- **Classification is right.** An invoice is `IS_INVOICE`, a delivery note is
  `IS_NOT_INVOICE`, and something genuinely undecidable is `UNCERTAIN`. A confident wrong
  answer is a failure however well the fields came out.
- **The vendor is the issuer**, not the recipient, and resolved to the right entity — a
  second document from the same company must find the same `vendors` row.
- **Every field is right, or correctly absent.** The total is the amount a person would pay,
  the date is the issue date, the currency is what the document says. A field the document
  does not print must come back null, never inferred.
- **Nothing is fabricated.** A total reconstructed from line items, an invoice number
  invented from a reference, a currency assumed from the language — each is a failure even
  when the answer happens to be right, because the next one will not be.
- **Every value came from the right line.** Read `bench/out/<name>/fields.txt` against the
  document. A parseable span from the wrong row is the failure this whole document exists
  for, and it is invisible from the value alone.
- **Re-running it produces no second invoice.**

A partially extracted invoice presented as complete is feature F's version of feature D's
silently dropped row. It is a failure, not a near miss.

---

## Binary invariants

Not thresholds. A single failure blocks release, and no volume of passing documents offsets
one. These are the decidable half, and they are covered by the suite.

- A document that reached `STORED` is **never deleted** by automated processing.
- Classification is **never flattened to a boolean**. `UNCERTAIN` is stored as `UNCERTAIN`
  and never written as `IS_NOT_INVOICE`.
- `UNREADABLE` and `NOT_AN_INVOICE` leave the document stored and manually linkable, and
  neither fails the workflow.
- Model output is schema-validated before anything persists, and a validation failure is
  recorded as state rather than crashing the workflow.
- An infrastructure failure never becomes a verdict on the document: it retries, and the
  document keeps whatever state it had.
- Re-processing one document creates no second invoice and no second `invoice_documents` row.
- No storage URL reaches the frontend; bytes leave only through the authorized route.
- Every query is workspace-scoped, and the attack tests in `tests/documents/isolation.test.ts`
  pass.
- No alias is ever written `confirmed: true` by automated processing.

---

## Measured thresholds

Across the fixture corpus, recorded with the run that produced them. **Every number below is
unset**, because `fixtures/invoices/` is empty (`BAN-150`) and choosing a threshold before
measuring anything is precisely what `architecture.md §21.4` forbids:

> Thresholds should be selected based on measured performance. They should not be arbitrarily
> chosen because an LLM reports a particular confidence number.

| Measure | Bar | Why there |
| --- | --- | --- |
| Classification false positives — a document confidently misclassified either way | **the tightest bar here** | `testing-strategy.md`: "a false positive costs more than asking the user… treat any increase in false positives as a regression even when the aggregate score improved." Saying `IS_INVOICE` about a quotation puts a charge in the accounts that never happened. `UNCERTAIN` is always the cheaper error. |
| Total correct, clean PDF | TBD | The field every match in feature G turns on. |
| Total correct, scan or photograph | TBD | `0003` accepts a higher error rate where a model reads values with nothing deterministic beneath it. The gap between this row and the one above is the OCR decision (`§21.1`). |
| Date correct | TBD | Matching is tolerant on date, so this may sit below the total's bar — but only by a measured amount. |
| Vendor resolved to the right entity | TBD | A vendor split in two is a duplicate the user sees; a vendor wrongly merged is two companies' invoices in one place. |
| Mislocation rate | TBD | Fields that parsed cleanly and came from the wrong line. The error `0010` cannot catch, and the reason the bench dumps spans beside values. |
| Schema-valid output rate | TBD | `testing-strategy.md` names it as an eval measure. A refusal is an outcome; a high refusal rate is a prompt problem. |

Filling this table is the work `§21.1` (which OCR provider) and `§21.2` (which model) were
deferred to. Until it is filled, `src/ai/model.ts`'s default is an explicit placeholder
rather than a decision, and `src/documents/text.ts`'s usable-text threshold is a guess that
has never been checked against a real scan.

---

## Two bars, because there are two kinds of done

Feature F's functionality and F's quality finish at different times, and holding the feature
open until both are settled would stop the phase dead — exactly as it would have for D.

### Feature F is complete when its functional bar is met

The binary invariants above all hold, both entry paths call one pipeline with no shortcut
around it, and the pipeline runs end to end on real invoices. That is decidable, and it is
what unblocks feature G.

### Phase 1 does not close until the streak is earned

**Six consecutive unseen invoices understood correctly on first attempt, with no code change
between them.**

Not a count of documents tested. A count of documents that taught us nothing — the only
observable sign that the discovery rate has fallen, and therefore the only evidence that the
next one is likely to work. A failure resets the streak.

The streak is earned **while G through L are built**, not before them. `BAN-152` is the
standing prompt.

This is the same deliberate trade D made, and it has the same cost: features built on F are
built on vendors and amounts that are still moving. G matches on exactly those, so an
extraction fix can change what G sees. The alternative — holding the phase still — costs
more, but the risk is real and belongs on the record rather than in someone's head.

If the streak has not been reached by the time L ships, that is a finding about `0010`'s
central claim and deserves a decision, not a quiet relaxation of the number.

### Corpus minimum

None of the above means anything measured over three clean SaaS receipts.

- **≥ 12 invoices**, across **≥ 8 distinct vendors** and **≥ 2 currencies**
- all three input paths, with at least **2 photographs** and **2 scans**
- at least one multi-page invoice, and one with a split tax breakdown (CGST/SGST)
- redacted and checked in under `fixtures/invoices/`, per `docs/testing-strategy.md`

As of 2026-09-21: **0 documents in hand, 0 redacted.** Tracked in `BAN-150`, and the
redaction is manual by rule. Unlike statements, the **amounts, dates and invoice numbers are
kept** — they are what is being measured, and redacting them destroys the fixture.

### Every failure donates a fixture

Already the rule in `docs/testing-strategy.md`, and it is the ratchet that makes the streak
mean something: a document that fails becomes a permanent test, so the same surprise cannot
be counted as new twice.

---

## The log

Every document's first impression, recorded before any fix. This is the eval artifact
`docs/architecture.md §21` asks for instead of an intuition.

Read `bench/out/<name>/fields.txt` against the document itself. The column that matters is
the span beside the value it became.

| # | Document | Path | First attempt | What it taught |
| --- | --- | --- | --- | --- |
| — | — | — | — | Nothing run yet. The corpus does not exist (`BAN-150`) and the AI Gateway has no credit (`BAN-149`). |

**First-attempt pass rate: 0 of 0. Current streak: 0.**

The zero is honest rather than flattering: feature F has never read a real invoice. Its
functional bar is met by construction and its tests, and every claim about whether it
_works_ is unevidenced until this table has rows in it.
