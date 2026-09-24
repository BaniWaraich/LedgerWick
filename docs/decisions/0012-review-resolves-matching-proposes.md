# 0012 — Review resolves, matching proposes

Status: Accepted · 2026-09-24 · Extends
`0011-matching-is-evidence-not-score.md` · Implements
`docs/workflows/invoice-match-review.md`

## Context

Feature G left two states, `NEEDS_REVIEW` and `NOT_FOUND`, that
`docs/state-machines.md §2` calls non-terminal and that nothing in the product could move a
requirement out of. Feature H is the screen that moves them.

`invoice-match-review.md §12` draws a boundary around it in one sentence:

> This workflow performs no searching, retrieval, or matching. Those have already happened.
> Its responsibilities are: present the evidence honestly, capture the user's decision,
> apply it, and persist only what the decision genuinely supports.

That sentence is easy to agree with and easy to erode. Every decision below is an attempt
to make it structural rather than a matter of care.

A second problem forced the timing. `reconciliation/page.tsx` selected requirements
`where state = 'IDENTIFIED'` and nothing else, so the moment G ran for real, every
requirement it touched left the only screen that listed them. The loop did not merely fail
to close — it lost things.

## Options

**Put review in `src/matching/`.** Fewer modules, and the candidate rows are already there.
But `src/matching/` is the module that searches and scores, so §12 would then be a rule
about which functions in one directory may call which others — enforceable by nobody.

**Let review write its own resolutions.** Direct, and it would mean a second
`isNull(resolutionMethod)` guard in a file whose author had no reason to know the first
one exists.

**Record rejections on the candidate row.** The obvious home, and wrong: `recordCandidates`
deletes and re-inserts the whole candidate set on every run, so a flag there is destroyed by
the next match and the user is asked the same question again.

**Ship the review screen without a queue.** The cleanest seam between H and feature I, and
it would leave the screen reachable only by typing a URL.

## Decision

**Review is its own module, it resolves nothing itself, and what it learns is keyed on
what the user actually confirmed.**

1. **`src/review/` exists**, separate from `src/matching/`, holding the read
   (`context.ts`), the four decisions (`resolve.ts`), the alias a confirmation teaches
   (`learning.ts`) and the duplicate comparison (`duplicates.ts`).

2. **Every write to `invoice_requirements.resolution_method` stays in
   `src/matching/link.ts`**, including the one resolution with no document to link.
   `resolveWithoutDocument` is deliberately the only function there that resolves a
   requirement while leaving `resolved_document_id` null.

3. **Rejections live on the requirement**, in `rejected_document_ids`, and
   `generateCandidates` honours them per (document, payment) pair.

4. **A run moves one requirement**, the transaction it actually proposes, and restores the
   prior state if it throws.

5. **Confirming a candidate writes a confirmed vendor alias**, keyed through
   `normalizeVendorName`.

6. **`NOT_REQUIRED` asks how far it applies** — this payment, or every payment to this
   vendor — and only the second writes Business Knowledge.

7. **`/reconciliation` becomes the action queue**, over `IDENTIFIED`, `NEEDS_REVIEW` and
   `NOT_FOUND`.

## Why

**Because the view model cannot render what it was never given.** `§5` forbids showing
confidence as a percentage. `ReviewCandidate` therefore has no `rank`, no score and no
number of any kind; `evidence: string[]` is the only confidence that reaches the page. A
rule saying "do not render a percentage" holds until someone is in a hurry. A shape with no
number in it does not.

**Because one guard is checkable and two are not.** `link.ts`'s header already claimed to
be the single funnel for resolutions. `NOT_REQUIRED` could not reuse either entry point —
both require a document — so the honest choice was to widen that file rather than to write
a second implementation of the `isNull(resolutionMethod)` guard somewhere it would be
missed.

**Because §9's warning is already solved by the machinery matching relies on.** §9 says
confirming a candidate teaches the alias, and warns in the same breath that one Adobe
receipt must not make every `RAZORPAY*` transaction Adobe. Those conflict only for the raw
narration. `normalizeVendorName` strips processor prefixes from a closed list before
anything else, so `RAZORPAY*ADOBE` reduces to `adobe` and never to `razorpay` — the alias
written is the payee, which is the thing the user confirmed.

This is also where the loop closes. `decide.ts` requires vendor evidence of `RESOLVED` or
`ALIAS` before an automatic link. Before a confirmation, a bank description the system has
never seen is `NONE`, so no payment to that vendor could ever match automatically. After
it, the same description resolves. **A match the user makes by hand this month is one the
system can make for them next month.**

**Because a rejection has to outlive the working-out that produced it.** The candidate set
is rebuilt on every run by design — a run proposing three where the last proposed five
should leave three. Anything stored there is transient. A rejection is not: `§7` says it
"should never be discarded, and it should never be treated as the user having taken no
action."

**Because one upload is one decision.** Marking every candidate's requirement put up to
five rows in the queue for a single decision about a single document, and resolving the
right one left four false alarms. Narrowing to the proposed transaction loses nothing,
because review reads candidates by `canonical_transaction_id`: a document that ranked some
other payment second is still shown, with its evidence, on that payment's own screen.

**Because a screen nobody can reach cannot be verified.** The queue is the minimum that
makes H usable and testable by a person, and it is a strict subset of feature I.

### What is being traded away

**`src/review/` and `src/matching/` both know about candidates**, from opposite ends. The
evidence format is now a contract between two modules rather than an internal detail of
one. `fromStored` and `describeAll` are the seam, and a change to the `Evidence` union now
has two readers to satisfy.

**An alias is written from a decision that was not about the vendor.** The user confirmed
which document pays which payment; we infer from that what the bank calls the vendor. It is
a small inference and a checkable one, but it is an inference, and §9's "ask rather than
assume" would have been the stricter reading. The mitigation is the normalizer and the
refusal to touch an alias another vendor already owns.

**`NOT_REQUIRED` costs the user a second click.** Always, including the common case where
one payment is all they meant. The alternative was to guess the breadth, which is what §9
warns against.

**`IDENTIFIED` in the queue is a deviation from `missing-invoice-report.md §6`**, which
names only `NOT_FOUND` and `NEEDS_REVIEW`. Until retrieval exists nothing searches, so
`IDENTIFIED` is where a requirement waits rather than a transient state on the way to being
searched for. When J and K land, this should be revisited rather than left.

## Consequences

**The evidence format is a published contract now.** `Evidence`, `fromStored` and
`describeAll` are read by review as well as written by matching. `tests/matching/evidence.test.ts`
pins the sentences verbatim against `§5`'s wording, and that test protects a screen in
another module.

**`docs/state-machines.md §2`'s message for `IDENTIFIED` changed** from "Waiting to
search…" to "Waiting for a document". Searching is one of two ways a document arrives and
it is the one that does not exist yet; telling a user we are about to search a mailbox they
have not connected is a promise the system cannot keep. When retrieval lands, the wording
is worth revisiting again.

**Feature I inherits a question this decision does not answer.** A `NOT_REQUIRED`
requirement is `RESOLVED` but was never *matched*, and `missing-invoice-report.md §5`
requires matched + not found + needs review to sum to documents required. The report must
either add a fourth bucket or exclude these from the denominator.
`resolution_method = 'NOT_REQUIRED'` is the discriminator and is already persisted, so H
owes I nothing further — but I should not have to discover it.

**A suspected duplicate that matched no payment has no requirement to hang a review on.**
H's screen is keyed on a requirement id. That case is reachable only from
`/documents/[documentId]`, and is left open rather than half-built.

**"What the system did" is honest and thin.** `§4` asks which mailboxes were searched over
what window. Nothing records a search, because retrieval is features J and K, so the screen
says no mailbox is connected. That is a known omission rather than a quietly missing
requirement, and `whatWeDid.searchedMailboxes` is the field it will fill.

**A `NOT_REQUIRED` fact and a clarification answer about one vendor share a key.** Both
write `(workspace, "vendor", key)`, so the later replaces the earlier. That is
`answer.ts`'s stated intent — a user changing their mind should not leave two contradictory
facts — but H makes it reachable from two workflows for the first time, and the user is
never told a fact was replaced.
