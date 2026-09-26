# 0016 — Retrieval proposes documents; one settle step decides the requirement

Status: Accepted · 2026-09-26 · Extends `0011-matching-is-evidence-not-score.md` and
`0012-review-resolves-matching-proposes.md` · Implements `docs/workflows/retrieve-invoices.md`

## Context

Feature K searches a Workspace's connected mailboxes for the document behind one Invoice
Requirement. Features F and G already exist. F turns a stored file into an Invoice. G takes
an Invoice, finds the transactions it could have paid for, and links it when a strict
conjunction of evidence holds.

Four facts forced a decision about how K fits between them.

**G decides from the invoice's side.** It asks "which payment is this invoice for?" and
links when exactly one candidate survives. Retrieval asks the opposite question: "which
document is this payment's?" Say two retrieved invoices each have exactly one candidate,
the same transaction. G links whichever finishes first. That is the ambiguity
`retrieve-invoices.md §13` sends to review, and here it would be settled by processing
order.

**A static rule forbids reaching Gmail and a model from one file.**
`tests/gmail/boundary.test.ts` fails any file that imports both, so credentials and mail
can never share a module with a prompt. Retrieval needs both: Gmail to find a document, and
F and G, which call models, to judge it.

**Gmail offers no stable key for an attachment.** An `attachmentId` differs between two
reads of the same message. The same message in two connected accounts has two message ids.
Retries and multiple accounts are both ordinary, so a document retrieved twice must be
recognisable as one document.

**`retrieve-invoices.md §11.1` says a retrieved document that is not an invoice resolves the
requirement.** But understanding extracts nothing from such a document. The only evidence
behind that link would be an email's sender and subject. `0011` refuses to link on less than
a full conjunction of evidence.

## Options

**Publish retrieved documents on `document/stored`, as uploads are.** No new machinery. F
understands them, G matches them, and the requirement moves as G decides. It inherits the
ordering problem above: the first of two equally good invoices links itself.

**One background function that searches, fetches, understands and matches.** One place,
easy to follow. It would reach Gmail and a model from one module, which the boundary test
forbids for a reason.

**Count completion events to know when every document is done.** Keeps F and G's functions
as they are. Counting needs a persisted notion of "matching has run on this invoice", which
does not exist. An invoice with zero candidates writes no rows at all. And it needs a
timeout for a document whose understanding never finishes.

**Two functions, and a settle step that sees every document at once.** What was chosen.

## Decision

**Retrieval proposes documents. G judges each one but links nothing. One settle step
decides the requirement from everything found.**

1. **Two background functions.**
   - `retrieve-documents` reaches Gmail and never a model. It searches, selects and
     fetches.
   - `assess-retrieval` reaches models and never Gmail. It calls the same
     `understandDocument` every upload goes through, then G's `proposeMatch`, then settles
     the requirement.

   Retrieved documents are not published on `document/stored`. They still take the one
   understanding pipeline, because they go through the same function.

2. **G proposes and does not link, for retrieved documents.** `proposeMatch` is the part of
   `matchInvoice` that records candidates and flags duplicates. `matchInvoice` is
   `proposeMatch` followed by acting on the result, so uploads behave exactly as before.

3. **The settle step is a requirement-level conjunction** (`decideRetrieval`, pure).
   `RESOLVED` with method `AUTO_RETRIEVED` requires every one of these:
   - exactly one eligible document has G's `AUTO_MATCH` on this transaction;
   - that document is classified `IS_INVOICE`;
   - no other eligible document is plausible for this transaction;
   - every mailbox that is not disconnected was searched, and no search pass was truncated;
   - the document has not been rejected for this requirement.

   Anything plausible that falls short of that is `NEEDS_REVIEW`. With nothing plausible, the
   requirement is `BLOCKED` if a mailbox could not be searched, and `NOT_FOUND` if every
   mailbox was.

4. **A document retrieved from Gmail is identified by its content hash.** A partial unique
   index `(workspace_id, content_hash) WHERE source = 'GMAIL'` holds this as a constraint. It
   does not depend on the code remembering to check.

5. **A retrieved document that is not an invoice is never linked automatically.**
   - `UNREADABLE`, `UNCERTAIN` and unfinished documents are plausible, and go to review.
   - `NOT_AN_INVOICE` documents are recorded and not offered.
   - Settled with the user on 2026-09-26. `retrieve-invoices.md §11.1` is amended to match.

6. **Retrieval adds no model call and no prompt.** Every model judgement is F's or G's.
   Nothing from Gmail reaches a model except an attachment's bytes, through F.

## Why

**Because ambiguity is a property of the requirement, and only the requirement can see it.**
Two invoices that each look perfect for one payment are not two confident answers. Together
they are one ambiguous question. A step that sees every document found for a requirement
can say so. Two invocations of an invoice-centric matcher cannot.

**Because the boundary test should stay true without effort.** The rule against a module
that reaches both Gmail and a model is enforced by a test, and that is how rules stay kept.
Splitting at the one point where Gmail stops and models start keeps it effortless.

**Because one fan-in point is simpler than counting.** `assess-retrieval` receives the list
of documents it must judge, judges each in turn, and decides. Inngest memoises each step,
and each domain function is idempotent by what it finds, so a retry resumes rather than
repeats. There is nothing to count and no event to miss.

**Because a hash is the only stable identity Gmail's data allows.** The same invoice reached
through two accounts, or fetched again on a retry, has the same bytes and nothing else in
common that can be relied on.

**Because a search is cheap and a link is not.** Selecting an email only costs a download
and a model call. So selection leans towards recall, and every piece of precision lives in
the settle conjunction, which inherits all of `0011`'s terms.

### What is being traded away

**Recall, again.** A payment with two genuine documents — an invoice and its receipt, both
extracted as invoices — goes to review, even though either would have done. That is the
direction `docs/testing-strategy.md` asks for, and it costs the user a click.

**A payment confirmation never resolves anything on its own.** `§11.1` wanted it to. A user
with many such documents will see more of the review queue than the workflow imagined.

**An unreachable mailbox holds back an otherwise certain link.** If one of three accounts
needs reauthorization, a perfect match in another still goes to review. The account we could
not search might hold a competing document, and the shortlist is not exhaustive. That is the
same reasoning as G's `truncated` term.

**Two functions to read instead of one.** The price of keeping the boundary structural.

## Consequences

- **New entities: Mailbox Search, Candidate Email, and the join between a Candidate Email
  and the documents fetched from it.** `docs/glossary.md` defines the first two. They are
  deliberately not Match Candidates, for the reason `0011` gives for two candidate tables.
- **`supporting_documents` gains `content_hash`.** `storeSupportingDocument` accepts one, and
  when a GMAIL document with that hash already exists it returns that row.
- **`src/matching/link.ts` gains `AUTO_RETRIEVED`.** It remains the only writer of
  `resolution_method`.
- **`docs/state-machines.md §2` gains the transitions retrieval needs**, plus two outcome
  fields: search outcome and fetch outcome.
- **HTML-only receipts are out of reach.** They have no attachment, and storing an email body
  is forbidden (`connect-gmail.md §5`). This is recorded as an OPEN DECISION in
  `retrieve-invoices.md`, not solved.
- **Quality is measured by `docs/retrieval-acceptance.md`, on the same terms as matching's
  log.** Until that log has rows, K is functionally complete and not quality-complete.
