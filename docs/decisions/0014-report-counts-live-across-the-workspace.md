# 0014 — The report counts live, across the workspace, every requirement once

Status: Accepted · 2026-09-25 · Implements `docs/workflows/missing-invoice-report.md`
· Answers the question `0012` left for feature I

## Context

`missing-invoice-report.md §5` asks that matched + not found + needs review sum to
_documents required_. Three facts about the system as built make that sentence untrue:

1. **Most requirements are in `IDENTIFIED`.** Nothing searches until Gmail retrieval
   (features J and K), so `IDENTIFIED` is where a requirement waits rather than a state it
   passes through. It belongs to none of the three.
2. **`NOT_REQUIRED` is `RESOLVED` but was never matched.** Feature H produces it, and
   `0012` recorded that I would have to decide where it goes.
3. **Runs are incremental.** `identifyRequirements` judges only transactions no earlier run
   has. A run started by answering one clarification question can judge one transaction
   and create no requirements, and the `transactions_processed` / `documents_required`
   columns on that run say exactly that.

`docs/phases/phase-1.md` finding 8 had already settled the principle — counts are computed
live from requirement state; the run supplies coverage, accounts and identity — without
settling what the counts are.

## Options

**The literal three-way sum.** Count only matched, not found and needs review, and let
documents required be their total. Honest only once retrieval exists; before that it hides
most requirements from the one number meant to say how much work remains.

**Fold `IDENTIFIED` into not found.** Makes the arithmetic work and is false:
`state-machines.md §2` defines `NOT_FOUND` as an assessment that completed, and nothing
has been assessed.

**Keep `NOT_REQUIRED` in the denominator as a visible fifth line.** Documents required would
never shrink after a run. But the glossary's rule is that a transaction needing no document
is not missing anything, and the user has just said this one needs none.

**Count the latest run only.** Matches §3's "latest Reconciliation Run" literally, and
reports near-zero after any small follow-up run.

**Strict queue.** Show only `NOT_FOUND` and `NEEDS_REVIEW`, as §6 names, leaving
`IDENTIFIED` as a count. Before K, that queue is empty for a user with requirements.

## Decision

1. **Every requirement is counted in exactly one line.** matched (`RESOLVED`, any method but
   `NOT_REQUIRED`) · not found · need review · waiting (`IDENTIFIED`, `SEARCHING`,
   `EVALUATING`, `FAILED`) · blocked. Those five sum to documents required, and the code
   asserts it.
2. **`NOT_REQUIRED` is outside documents required**, and shown as its own line so the number
   that left is visible.
3. **The counts cover the whole workspace, live.** Transactions processed is the
   workspace's canonical transactions; the requirement lines cover all its requirements.
   The latest run supplies identity, date, state and coverage. The accounts are those with a
   completed statement — the same statements coverage is read from — because no column on
   a run records them and a migration to duplicate a derivable fact is not warranted.
4. **`IDENTIFIED` stays in the queue under its own filter**, Waiting for a document,
   continuing the deviation `0012` made.

## Why

A summary is only useful if the user can reconcile it: every requirement they can find
anywhere in the product must appear in exactly one of its numbers. The bucket function is an
exhaustive switch over the state enum, so a state added later fails to compile rather than
silently falling out of the sum.

What is traded away: the summary is no longer the three-line picture §5 draws, and before
retrieval exists its largest line is "waiting". That is the truth about a product with no
retrieval yet.

## Consequences

- `reconciliation_runs.transactions_processed` and `documents_required` remain a record of
  what one run did. The report does not read them.
- Transactions processed includes transactions no run has judged yet — a failed batch, or
  one awaiting a clarification answer — because nothing persists "judged without a
  requirement". The open-questions prompt accounts for the second.
- Coverage gaps (§5) stay deferred with the rest of coverage-gap reporting
  (`phase-1.md §3`); the span is shown, gaps are not.
- The blocked prompt states a count and not an account until J records connections.
- **When K lands, revisit** whether `IDENTIFIED` belongs in the queue at all, and the
  "waiting" wording with it.
- Feature L (export) should place rows with the same bucket function rather than restate
  the rule.
