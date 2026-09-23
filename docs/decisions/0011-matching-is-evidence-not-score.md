# 0011 — Matching decides from evidence, and a model may only confirm or veto

Status: Accepted · 2026-09-23 · Extends `0003-llm-for-structure-not-values.md` ·
Implements `architecture.md §10`

## Context

Feature G links an Invoice to the Canonical Transaction it paid for. It is the first place
in the system where an automated decision writes a relationship a business owner will
later rely on without checking.

The asymmetry that shapes everything below is stated in `docs/testing-strategy.md`: **a
false positive costs more than asking the user.** An invoice attached to the wrong
transaction is worse than an invoice attached to nothing, and it is worse in a specific
way — it looks finished. An unmatched invoice sits in a queue asking to be dealt with. A
wrongly matched one is silent, it is in the Excel export, and the only person who can
catch it is the accountant reading a reconciliation they were told was complete.

`architecture.md §10` already divides the work into three stages: deterministic candidate
generation, AI reasoning over what survives, application decides. `§10.1` already says
confidence must come from observable evidence rather than a model asserting a percentage.
`§21.3` and `§21.4` already say the thresholds are an empirical question and must not be
guessed at in the architecture.

What none of them settles is how those rules survive contact with an implementation, and
specifically: where a model's opinion enters, what it is allowed to do once it is there,
and what stops the next change from quietly making it the decider.

The forcing question is that G is being built while it cannot be measured. The AI Gateway
has no credit (`BAN-149`) and `fixtures/invoices/` is empty (`BAN-150`). Feature D's
history is the warning: 466 passing tests sat alongside a parser dropping 71% of a real
statement, because the bar asked for an activity — "measured at least once" — rather than a
threshold. Matching has no balance equation either. It has nothing at all.

## Options

**Score the evidence, threshold the score.** Weight each signal, sum, compare. Familiar,
and the weights are exactly the unmeasured numbers this decision is trying not to invent.
Worse, a score is lossy in the direction that matters: by the time it is one number, the
reason is gone, and `phase-1.md §7 H` requires the user be shown the evidence rather than a
percentage.

**Ask the model for a confidence and threshold that.** `§10.1` rejects it outright. A model
reporting 95% is reporting a number it generated, not a measurement of anything, and it is
uncalibrated in a way that cannot be audited from the output.

**Let the model choose the transaction.** Simplest to write, and it makes the model the
author of the link. Every guardrail afterwards is then a filter on something already
decided, which is the opposite of `0003`'s line.

**Deterministic policy, model as one input that may only subtract.** What was chosen.

## Decision

**A link is originated by deterministic code, over a bounded candidate set, from observable
evidence. The model contributes one opinion, and that opinion can only confirm a link the
policy already supports or prevent one — never create it.**

Concretely:

1. **Stage 1 is a query, not a question.** Candidates come from one bounded read over
   `canonical_transactions` within a date window around the invoice date, debits only,
   under a row cap. The model is never asked to search.

2. **Evidence is a structured fact, not a number.** Each of amount, date, vendor, invoice
   number and currency produces an item carrying its raw operands — the two amounts and
   their difference, the offset in days, the description the vendor was matched against.
   The evidence is persisted alongside the candidate.

3. **The model's output schema has no numeric field.** It returns a candidate *position* in
   a numbered list, a verdict of `SAME` / `UNSURE` / `DIFFERENT`, and a reason in prose.

4. **`AUTO_MATCH` is a conjunction, and every term is required.** Exactly one surviving
   candidate; same currency; exactly equal amounts; date inside the auto-match window;
   vendor resolved or matched through a known alias; the model agreeing, on that same
   candidate; no suspected duplicate; the transaction holding no invoice already. Anything
   else with a candidate is `NEEDS_REVIEW`.

5. **Every number lives in `src/matching/thresholds.ts`**, labelled unmeasured, and no other
   file in `src/matching/` may hold a literal window or tolerance.

## Why

**Because the schema is a better guarantee than the prose.** A rule that says "do not use a
model-reported confidence" is followed until someone is in a hurry. A schema with no number
field in it cannot be violated without a visible change to the schema, in a diff, in a
versioned prompt file. The same reasoning runs through the whole decision: the constraints
that matter are the ones a future change cannot satisfy accidentally.

**Because a conjunction fails safe and a score fails silently.** Under a weighted score, a
signal being absent is a slightly lower number, which may still clear the bar — so an
invoice with no vendor match and a very close amount can auto-link. Under a conjunction, an
absent term is a stop. The failure mode is "asked the user when it did not need to", which
is the cheap direction.

**Because the evidence is the product.** `invoice-match-review.md §5` shows a user "Amount
matches exactly · Dated the same day as the transaction · Invoice number not present in the
transaction description" and says why: "A percentage tells the user nothing they can check."
Storing facts rather than a score is what makes that screen possible at all, and it makes
feature H a renderer rather than a second implementation of Stage 1.

**Because the model is genuinely useful at exactly one thing here.** `RAZORPAY*ABCFOODS`
being ABC Foods Private Limited is a semantic judgment that deterministic normalization
gets wrong at the edges. That is worth a model call. Choosing which of four transactions a
business paid is not a different-in-kind judgment — it is the same evidence, and code can
weigh it reproducibly.

### What is being traded away

**Recall.** This will ask the user about matches a looser system would have made
automatically, and some of those would have been right. That is the intended trade and it
is the one `testing-strategy.md` asks for, but it is a real cost paid in the user's
attention, every time.

**The model cannot rescue a case the policy has no term for.** An invoice paid in two
instalments, a transaction whose amount includes a bank fee, a vendor the system has never
seen under a name it has never seen — a stronger model reading the documents might get
those right, and this design will send all of them to review. Widening the policy means a
new term with a new unmeasured number, which is deliberately awkward.

**Exact-amount equality is strict to the point of bluntness.** Any FX case, any rounding,
any fee is out of auto-match by construction. `domain-model.md` allows amounts to differ
legitimately; this refuses to act on that unsupervised until there is evidence about how
often it is safe.

**No index for amount-based narrowing.** Candidate generation leans on the existing
`canonical_transactions_workspace_date_idx` and a row cap. For one small business over a
short window that is tens of rows. It is a guess that it stays that way, and the honest
reason not to add `(workspace_id, amount_minor)` now is that the bench will say whether it
is needed and guessing is the habit this record exists to break.

## Consequences

**The thresholds in `src/matching/thresholds.ts` are provisional and the code says so.**
They are not a measurement and must not be cited as one. `docs/matching-acceptance.md` is
the log that replaces them with evidence, and it counts false positives in their own column
— an increase there is a regression even when the aggregate improves.

**Feature G's completion bar is split, as D's and F's already are.** The functional bar —
the pipeline works, the invariants hold, the policy is exercised — is met inside G. The
quality bar is met only after six consecutive clean first impressions in
`docs/matching-acceptance.md`, and that gates **Phase 1**, not G. `phase-1.md §7 G` should
say so in the same words it uses for F.

**Two candidate tables, not one.** `invoice_match_candidates` holds transactions proposed
for an invoice. Retrieval will need documents proposed for a requirement, which is a
different pair of things with a different evidence vocabulary — a sender, a subject, an
attachment name. One table serving both needs a `kind` column and two nullable foreign-key
pairs, and every query then carries a filter the type system cannot enforce. That is the
shape `workspace-scope.ts` exists to make impossible, and it is not worth reintroducing for
the sake of one fewer table.

**Duplicate detection runs after the Invoice row exists, which `manual-invoice-upload.md §13`
does not say.** §13 says to check "before creating a new invoice record". Feature F creates
it during extraction (`src/documents/understand.ts:200`), deliberately, and moving creation
into G would make F depend on G and reopen `0010`. So the check is the first thing matching
does: after the row exists, before anything is linked or shown. The second Invoice exists,
flagged, unlinked, and never auto-matched.

**§13's intent holds and its wording does not.** "The system should not silently create a
second invoice" is satisfied — nothing is silent, nothing is linked, the user is asked. "The
system checks before creating" is not. This is recorded here rather than left as a
discrepancy between a workflow document and the code for someone to find later. If the
distinction ever turns out to matter — a user seeing two invoice rows where they expected
one — the fix is a new record, not a quiet change of order.

**An invoice that matches a transaction carrying no Invoice Requirement is still linked.**
`§14` allows it: "An upload with no requirement to resolve … still creates the document and
the Invoice, and may be linked to a transaction later." The one-to-one invariant constrains
invoices and transactions, not requirements. Nothing is resolved and the Missing Invoice
Report is unchanged, because nothing was missing.

**Credit transactions are not candidates.** `domain-model.md §11.1` puts refunds and
incoming credits outside V1, and `src/requirements/identify.ts` already refuses a
requirement for a `CREDIT`. Matching inherits that boundary rather than re-deciding it. If
credit notes come into scope, this is one of the places that has to change, and it is named
here so the search finds it.
