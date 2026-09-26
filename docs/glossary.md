# Glossary

This document defines the canonical vocabulary for the system.

One concept has exactly one name. Where a term appears in `docs/architecture.md`,
`docs/domain-model.md`, or a workflow document, it carries the meaning defined here.

If a change requires a new concept, add it here first.

Items marked **OPEN DECISION** are unresolved and must be settled before the affected
code is written. They are recorded rather than silently decided.

---

## Product

### Muneem Ji / Ledgerwick

Two names for one product, both current.

- **Muneem Ji** is the internal project name. Use it in the documents in `docs/`, in
  design discussion, and in commit messages.
- **Ledgerwick** is the official product name. Use it in anything a customer sees: the
  website, the application UI, user-facing copy, the domain, the logo, and package
  metadata.

Neither is a rename of the other, and neither is deprecated. When writing a user-facing
string, the product is Ledgerwick.

---

## Money and accounts

### Workspace

A business's isolated financial environment. The authorization boundary for every
operation. Synonymous with **Business** in V1; prefer **Workspace** in code.

### Bank Account

A financial account belonging to a Workspace. Owns Canonical Transactions.

A credit card is a Bank Account whose **Account Kind** is `CREDIT_CARD`. The money moves
the same way and needs the same invoices, so it is the same thing to every workflow that
reads it; the kind records the difference where one exists.

### Account Kind

What sort of account a Bank Account is: `BANK_ACCOUNT` or `CREDIT_CARD`. Descriptive, not
identifying — two accounts are the same account because they share a bank and an account
identifier, never because they share a kind.

### Currency

The unit a Bank Account's money is counted in, as an ISO 4217 code. Established when the
account is created, from what its first statement said, and never rewritten afterwards —
Canonical Transactions carry a currency of their own, so changing an account's currency
later would re-denominate history.

Each currency has a **minor-unit exponent** (2 for INR, 0 for JPY), which is what makes
the integer amounts of `docs/decisions/0004-data-access.md` readable.

### Bank Statement

An uploaded file covering one Bank Account for one period. An input, not a source of
truth. Produces Statement Lines.

Both bank account statements and credit card statements are Bank Statements. Nothing else
is.

### Statement Period

The date range a Bank Statement covers. **Declared** when the document states it,
**derived** when it did not and the range was taken from the transactions the statement
turned out to contain. Which of the two it is, is recorded; see
`docs/decisions/0008-statement-period-provenance.md`.

### Statement Line

One transaction row exactly as it was extracted from one Bank Statement.

A Statement Line is immutable evidence of what a particular statement said. It is not
the business's record of the payment. Two overlapping statements covering the same
payment produce two Statement Lines.

### Canonical Transaction

The business's single record of one financial movement, derived from one or more
Statement Lines.

This is the transaction that the rest of the system reasons about: invoice requirements,
retrieval, reconciliation, and the report all reference the Canonical Transaction, never
a Statement Line. Deduplication across overlapping statements happens exactly once, when
Statement Lines are promoted to Canonical Transactions.

See `docs/workflows/upload-statement.md` for the identity rule.

### Statement Coverage

The set of date ranges, per Bank Account, for which the Workspace has uploaded a
successfully processed Bank Statement.

Used to detect periods the business has not yet provided, and to explain to the user
what a reconciliation run actually examined.

---

## Documents and invoices

### Supporting Document

Any stored file offered as evidence of a business transaction: an invoice, a receipt, a
payment confirmation, or comparable proof of purchase or payment.

"Supporting Document" is the broad category. It makes no claim that the file is an
invoice or that it is sufficient for any particular tax or accounting purpose.

Every file that enters the system — retrieved from Gmail or uploaded by the user — is a
Supporting Document first.

### Invoice

A Supporting Document that has been classified as representing a charge from a Vendor to
the Workspace, and from which invoice information has been extracted.

An Invoice is a domain object distinct from the file(s) representing it. An Invoice may
be linked to at most one Canonical Transaction, and a Canonical Transaction to at most
one Invoice.

Not every Supporting Document becomes an Invoice. A retrieved payment confirmation that
cannot be classified as an invoice remains a Supporting Document attached to its Invoice
Requirement, and the requirement is resolved on that basis. See
`docs/domain-model.md §5.1`.

### Invoice Document

The stored file representing an Invoice: the original bytes plus its metadata and
processing state. An Invoice may have several.

Every Invoice Document is a Supporting Document; the reverse is not true.

### Vendor

An entity that issues Invoices to the Workspace. Belongs to a Workspace.

### Vendor Alias

An alternate representation of a Vendor: trade name, abbreviation, or the form the Vendor
takes in a bank description or payment-processor string.

A **confirmed** alias is one the user established or approved; it is authoritative
business knowledge. An **inferred** alias is a model suggestion; it may be used to widen
a search within the run that produced it, but it is not persisted as business knowledge
until confirmed. See `docs/architecture.md §11`.

---

## Reconciliation

### Invoice Requirement

The system's persisted determination that a specific Canonical Transaction should have a
Supporting Document.

This is the unit of work for retrieval and the row shown in the report. It is a durable
entity with an identity, a state, and a history — not a value recomputed on each run.

At most one Invoice Requirement exists per Canonical Transaction.

Replaces the earlier terms "Expected Invoice" and "invoice requirement" used
interchangeably in the original documents.

### Missing Invoice

Not an entity. The condition of an Invoice Requirement that has not been satisfactorily
resolved. Derived from Invoice Requirement state.

### Reconciliation Run

One execution of the pipeline over a Workspace: statements processed, requirements
identified, documents retrieved, matches proposed.

A Run has an identity, a start and end time, the Statement Coverage it examined, and the
counts it produced. The Missing Invoice Report displays the latest Run. Runs are retained
so that a later Run can process only what is genuinely new.

### Match

The link between an Invoice Requirement and the Supporting Document that satisfies it,
together with how it was established: automatically, after user review, or by explicit
manual linking.

Where the Supporting Document was classified as an Invoice, the same Match is also the
link between that Invoice and the Canonical Transaction — one relationship seen from two
ends, not two relationships. A document that is not an Invoice links to the Canonical
Transaction directly and satisfies the Requirement just the same
(`docs/domain-model.md §5.1`).

### Match Candidate

A Canonical Transaction the system proposes as the possible subject of an Invoice,
together with the evidence for it.

A Candidate is a proposal, never a decision. It is produced deterministically, from a
bounded set — the system does not ask a model to search the transactions — and it carries
the observable facts that put it there: whether the amounts agree, how far apart the dates
are, whether the vendor resolved, whether the invoice number appears in the transaction
description. Those facts are what the user is shown when the system asks
(`docs/workflows/invoice-match-review.md §5`); a Candidate has no score and no percentage.

Several Candidates may exist for one Invoice, and having Candidates is not the same as
having a Match. A Match exists only once one of them is linked.

A Candidate for an Invoice is a transaction. When Gmail retrieval proposes documents for
an Invoice Requirement, those are a different kind of proposal about a different pair of
things, and the two are not the same entity.

### Suspected Duplicate

An Invoice the system believes may be the same underlying invoice as one already on file —
most often the same document retrieved from Gmail and later uploaded by hand.

Suspected, and never acted on alone. A Suspected Duplicate is never linked automatically
and is never silently merged; it is put in front of the user with both documents and the
fields that agree and disagree. If they are the same, both files are retained as documents
of one Invoice and the user chooses which is primary. Nothing is deleted — the user asked
to deduplicate a record, not to destroy a file.

### Business Knowledge

Durable, Workspace-scoped facts learned from a user's confirmed decisions: confirmed
Vendor Aliases, vendor classifications, transactions that never require documentation,
and the answers to previously asked clarification questions.

Business Knowledge is structured domain data, not model memory. Only confirmed
information becomes Business Knowledge.

### Clarification Question

A question the system asks the user when it cannot determine the nature of a Canonical
Transaction on its own. Persisted, because the user may be away when it is raised. Its
answer may become Business Knowledge.

---

## Mail

### Gmail Connection

One Google account a Workspace has authorized Muneem Ji to read mail from, together with
the credentials that authorization produced and the state of its health
(`docs/state-machines.md §6`).

Belongs to exactly one Workspace. A Workspace may hold several, one per Google account,
and the same Google account connected to two Workspaces is two Gmail Connections with two
sets of credentials — never one shared between them. A Gmail Connection is identified
within its Workspace by the Google account's stable subject identifier, not its address.

Not the same thing as the Google identity a User signs in with. Signing in proves who the
User is and asks for no access to mail; a Gmail Connection grants access to mail and proves
nothing about who is signed in. The two may be the same Google account, and are still two
different things. Where earlier documents say **Google Account** meaning a mailbox the
system searches, they mean this.

---

## Deprecated terms

Do not use these; they appear in earlier revisions of the documents.

| Deprecated                                             | Use instead           |
| ------------------------------------------------------ | --------------------- |
| Expected Invoice                                       | Invoice Requirement   |
| Reconciliation Batch                                   | Reconciliation Run    |
| Transaction (unqualified, meaning a statement row)     | Statement Line        |
| Transaction (unqualified, meaning the business record) | Canonical Transaction |
