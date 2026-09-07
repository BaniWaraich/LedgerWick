# Muneem Ji Domain Model

## 1. Purpose

The domain model describes the business concepts that Muneem Ji represents, the relationships between those concepts, their meaningful states, and the business rules that govern them.

It is intentionally independent of implementation details such as databases, APIs, OCR providers, LLMs, agents, background jobs, and frontend components.

The canonical name of every concept below is defined in `docs/glossary.md`. The states
referenced in section 7 are defined authoritatively in `docs/state-machines.md`.

The purpose of this document is to establish a shared understanding of what exists in the Muneem Ji domain before designing how the software implements it.

---

# 2. Actors

## 2.1 Business Owner

The person using Muneem Ji to manage a business's financial records and invoices.

The Business Owner can:

- create and manage Workspaces/Businesses,
- connect Google Accounts,
- upload bank statements,
- upload invoices,
- review identified invoices,
- review proposed invoice-to-transaction matches,
- confirm or reject matches,
- manually link invoices to transactions,
- review missing invoices,
- retrieve and download invoice documents.

---

# 3. Core Domain Entities

## 3.1 User

The person who has an account with Muneem Ji.

A User may have multiple Workspaces/Businesses.

```text
User
 ├── Workspace / Business A
 ├── Workspace / Business B
 └── Workspace / Business C
```

---

## 3.2 Workspace / Business

A Workspace represents a Business's isolated financial environment within Muneem Ji.

For V1, "Workspace" and "Business" are synonymous.

A User may belong to and operate multiple Workspaces/Businesses.

Each Workspace/Business contains its own:

- Bank Accounts
- Transactions
- Invoices
- Vendors
- Subscriptions
- connected Google Accounts
- other financial records

Data belonging to one Workspace must remain isolated from another Workspace belonging to the same User.

---

## 3.3 Bank Account

A financial account belonging to a Workspace/Business.

A Bank Account produces or contains financial Transactions.

Important conceptual attributes may include:

- account identifier
- account name
- financial institution
- currency
- account type

---

## 3.4 Bank Statement

A document or dataset representing transactions from a Bank Account for a particular period.

A Bank Statement is an input from which Muneem Ji obtains Transactions.

A statement may contain:

- account information
- statement period
- opening balance
- closing balance
- transactions

A Bank Statement may require parsing and/or processing before its Transactions become available to the rest of the system.

The statement period is **not optional**. Every successfully processed Bank Statement must
record the date range it covers, because the system relies on that range to determine what
it has and has not seen.

### Statement Coverage

Statement Coverage is the set of date ranges, per Bank Account, for which the Workspace has
a successfully processed Bank Statement.

Coverage exists so that the system can answer two questions:

- Which periods has the business not yet provided?
- Which periods did a given reconciliation examine?

Statements may overlap. Overlapping coverage is normal and must not produce duplicated
financial records; see section 3.5.

---

## 3.5 Transaction

A financial movement recorded against a Bank Account.

Examples include:

- payments
- purchases
- receipts
- debits
- credits
- refunds

Important conceptual attributes may include:

- transaction date
- amount
- currency
- description
- debit/credit direction
- reference/transaction identifier, where available
- associated Bank Account

A Transaction may have **at most one Invoice relationship**.

### Statement Line and Canonical Transaction

A financial movement and the statement rows describing it are separate things.

```text
Statement A ──► Statement Line ──┐
                                 ├──► Canonical Transaction
Statement B ──► Statement Line ──┘
```

A **Statement Line** is one row exactly as extracted from one Bank Statement. It is
immutable evidence of what that statement said, and it retains its link to the statement
it came from.

A **Canonical Transaction** is the business's single record of the underlying financial
movement. It is what the rest of the domain reasons about.

When two statements overlap, the same payment appears as two Statement Lines and one
Canonical Transaction. Deduplication happens exactly once, at the point Statement Lines
are promoted to Canonical Transactions; every later workflow may assume it has already
happened.

Unqualified uses of "Transaction" elsewhere in this document mean Canonical Transaction.

The identity rule that decides whether two Statement Lines describe the same movement is
defined in `docs/workflows/upload-statement.md`.

---

## 3.6 Invoice

An Invoice is a financial document representing a charge from a Vendor to the Workspace/Business.

An Invoice is a domain object independent of the physical/digital document through which it was obtained.

Important conceptual attributes may include:

- Vendor
- invoice number, where available
- invoice date
- total amount
- currency
- tax amount, where available
- subtotal, where available

An Invoice may consist of or be represented by **multiple Invoice Documents**, including multi-page documents.

An Invoice may be linked to **at most one Transaction**.

---

## 3.7 Invoice Document

An Invoice Document is a physical or digital representation of an Invoice.

Examples include:

- a PDF
- a scanned document
- a photograph of a physical invoice
- a multi-page invoice
- an invoice document retrieved from Google Account/Gmail
- an invoice document manually uploaded by the Business Owner

One Invoice may have multiple Invoice Documents.

For example, the same Invoice could theoretically have:

```text
Invoice
 ├── Page/document 1
 ├── Page/document 2
 └── Page/document 3
```

Alternatively, multiple copies or representations of the same Invoice may enter the system through different sources.

The system should distinguish the underlying Invoice from the documents representing it.

---

## 3.8 Vendor

A Vendor is an entity that issues Invoices to the Workspace/Business.

A Vendor may have:

- legal name
- trade name
- aliases
- alternate names
- payment-provider representations
- other identifying information

Different names appearing on invoices, bank statements, and payment processors may represent the same Vendor.

A Vendor belongs to a Workspace/Business.

---

## 3.9 Subscription

A Subscription represents an ongoing or recurring commercial relationship between a Workspace/Business and a Vendor.

Examples may include:

- software subscriptions
- SaaS services
- recurring service providers
- other recurring business expenses

A Subscription is associated with a Vendor and may result in recurring Transactions and Invoices.

Subscriptions are part of the Muneem Ji V1 domain.

The precise rules for identifying and maintaining a Subscription will be defined separately.

---

## 3.10 Google Account

A Google Account is an account connected by the Business Owner and authorized for Muneem Ji to search for and retrieve invoice documents.

For V1, Google Accounts are the only supported external source for automatically retrieving invoices.

A Workspace may have one or more connected Google Accounts.

Google Accounts are therefore part of the current domain model because they represent an established source of Invoice Documents in V1.

---

## 3.11 Supporting Document

A Supporting Document is any stored file offered as evidence of a business transaction:
an invoice, a receipt, a payment confirmation, or comparable proof of purchase or payment.

Supporting Document is the broad category. Every file entering the system — retrieved
automatically or uploaded by the user — is a Supporting Document before anything else is
known about it.

An Invoice Document (3.7) is a Supporting Document that has been classified as
representing an Invoice. The reverse does not hold: a payment confirmation may be a
perfectly good Supporting Document without ever becoming an Invoice.

Whether a particular document is sufficient for a specific tax or accounting purpose
depends on the business and its jurisdiction. The domain makes no such claim.

---

## 3.12 Invoice Requirement

An Invoice Requirement is the system's determination that a specific Canonical Transaction
should have a Supporting Document.

It is a **persistent entity**, not a value recomputed on demand. It has an identity, a
state, and a history, because:

- retrieval work is performed against it and must be resumable and idempotent,
- the user acts on it and those actions must survive,
- it is the row shown in the Missing Invoice Report.

At most one Invoice Requirement exists per Canonical Transaction.

An Invoice Requirement records:

- the Canonical Transaction it concerns,
- why a document is believed to be required,
- its current state (see `docs/state-machines.md §2`),
- the Supporting Document that resolved it, where one exists,
- how it was resolved.

An Invoice Requirement is **resolved** when a Supporting Document is linked to its
Canonical Transaction, or when the user determines that no document is required.

This entity was previously described as the derived concept "Expected Invoice". It is a
persisted entity.

---

## 3.13 Reconciliation Run

A Reconciliation Run is one execution of the reconciliation pipeline over a Workspace.

A Run records:

- when it started and finished,
- the Statement Coverage it examined,
- the Bank Accounts included,
- the Canonical Transactions it processed,
- the resulting counts.

Runs are retained. History is what allows a later Run to process only what is genuinely
new rather than reprocessing everything the business has ever uploaded.

A Run is a record of work performed. It is not a source of truth about the current state
of any Invoice Requirement — the requirement itself holds that.

---

## 3.14 Business Knowledge

Business Knowledge is durable, Workspace-scoped fact learned from a user's confirmed
decisions.

Examples:

- a confirmed Vendor Alias,
- the classification of a vendor as a business supplier or a personal payee,
- a transaction pattern that never requires documentation,
- an answer previously given to a Clarification Question.

Business Knowledge is structured domain data belonging to the Workspace. It is not model
memory, and it is never created from an unconfirmed inference.

Its purpose is to reduce the questions the system needs to ask over time.

---

## 3.15 Clarification Question

A Clarification Question is a question raised for the Business Owner when the system
cannot determine the nature of a Canonical Transaction on its own.

It is persisted, because the user may not be present when it is raised and must be able to
answer later. A question records the transaction it concerns, what was asked, and the
answer once given.

An answer may become Business Knowledge where it is useful beyond the transaction that
prompted it.

---

# 4. Domain Relationships

The core relationships are:

```text
User
  │
  ├── has many → Workspaces / Businesses
  │
  └── may connect/manage → Google Accounts
```

```text
Workspace / Business
  │
  ├── has many → Bank Accounts
  │                   │
  │                   └── has many → Transactions
  │
  ├── has many → Invoices
  │                   │
  │                   ├── issued by → Vendor
  │                   ├── represented by → Invoice Documents
  │                   └── linked to → Transaction (0 or 1)
  │
  ├── has many → Vendors
  │
  ├── has many → Subscriptions
  │
  ├── has many → Invoice Requirements
  │                   │
  │                   ├── concerns → Canonical Transaction (exactly 1)
  │                   └── resolved by → Supporting Document (0 or 1)
  │
  ├── has many → Reconciliation Runs
  │
  ├── has many → Business Knowledge entries
  │
  └── connects → Google Accounts
```

### Invoice ↔ Transaction

The relationship is intentionally **one-to-one at most**:

```text
Invoice 0..1 ───────── 0..1 Transaction
```

An Invoice cannot be linked to multiple Transactions.

A Transaction cannot be linked to multiple Invoices.

This constraint is part of the current V1 domain model.

---

# 5. Invoice Document and Invoice Relationship

The physical/digital document and the underlying Invoice are separate concepts.

```text
Invoice
   │
   ├── Document
   ├── Document
   └── Document
```

An Invoice can therefore have multiple documents.

A document may be:

- retrieved automatically,
- manually uploaded,
- a photograph,
- a scan,
- a PDF,
- one of multiple pages/representations.

The existence of a Document does not automatically establish that:

1. the document is an Invoice,
2. the Invoice has been correctly extracted,
3. the Invoice has been matched to a Transaction.

Those are separate decisions.

## 5.1 When a Supporting Document is not an Invoice

Not every document that resolves an Invoice Requirement becomes an Invoice.

A retrieved payment confirmation may be adequate evidence of a business expense while
containing too little information to be classified and extracted as an Invoice.

The domain therefore distinguishes two ways a requirement is resolved:

```text
Supporting Document
        │
        ├── classified as an invoice → Invoice created → Invoice ↔ Transaction link
        │
        └── not classified as an invoice → Document linked to the Transaction directly
```

Both resolve the Invoice Requirement. Only the first creates an Invoice, and therefore
only the first is constrained by the one-to-one Invoice ↔ Transaction rule.

This keeps the Invoice ↔ Transaction invariant meaningful — it constrains extracted
invoices, not arbitrary evidence — while allowing a receipt to satisfy the business need.

A Canonical Transaction may hold several Supporting Documents, but at most one Invoice.

---

# 6. Invoice Processing Concepts

Processing is not itself a core domain entity.

It is a process through which an Invoice Document becomes usable domain information.

Conceptually:

```text
Invoice Document
       ↓
Document Processing
       ↓
Invoice Classification
       ↓
Information Extraction
       ↓
Invoice
       ↓
Reconciliation
       ↓
Transaction Relationship
```

The implementation of this process is outside the domain model.

---

# 7. Important States

States should be understood as belonging to particular domain objects or processes rather than being one universal list.

The state names, transitions, and terminality of each are defined authoritatively in
`docs/state-machines.md`. The subsections below describe what those states mean in the
domain; where the two documents differ, `docs/state-machines.md` is correct.

## 7.1 Bank Statement Processing

A Bank Statement may be:

- Not processed
- Processing
- Parsed successfully
- Parsed with discrepancies
- Parsing failed

A successfully processed statement produces Transactions that can be used by the rest of the system.

---

## 7.2 Invoice Document Processing

An Invoice Document may be:

- Not processed
- Processing
- Successfully processed
- Processing failed

Processing failure does not necessarily mean the document is invalid.

---

## 7.3 Invoice Classification

A processed Invoice Document may be:

- Identified as an invoice
- Uncertain / requires review
- Not identified as an invoice

The system should distinguish uncertainty from a definitive determination that the document is not an invoice.

---

## 7.4 Invoice Extraction

An Invoice may have:

- Extracted information
- Partially extracted information
- Extraction failure

Not every Invoice will contain every possible field.

---

## 7.5 Invoice Reconciliation

An Invoice may be:

- Unmatched
- Candidate match identified
- Matched
- User confirmed
- User rejected

The exact persistence of these states will be determined during architecture design.

---

## 7.6 Invoice Retrieval

Retrieval is a process rather than a permanent state of the Invoice.

A retrieval attempt may result in:

- Not attempted
- Searching
- Invoice found
- Invoice retrieved
- No invoice found
- Retrieval failed
- Multiple possible invoices found
- User review required

"Found" and "retrieved" are distinct outcomes.

For example, Muneem Ji may identify an email containing evidence of an invoice but fail to obtain a usable Invoice Document from it.

---

# 8. Derived Concepts

## 8.1 Expected Invoice — superseded

"Expected Invoice" was originally described here as a derived concept. It is not derived:
the system performs work against it, the user acts on it, and both must persist.

It is now the **Invoice Requirement** entity defined in section 3.12.

The rules determining when a document is required are defined in
`docs/workflows/identifying-invoices.md`.

---

## 8.2 Missing Invoice

A Missing Invoice is not necessarily an independent persistent entity.

It represents the condition in which an Invoice Requirement has not been satisfactorily resolved.

Conceptually:

```text
Transaction
     │
     ├── Invoice expected? → YES
     │
     └── Invoice linked?   → NO
                              ↓
                       Missing Invoice
```

Therefore, a Missing Invoice is derived: it is an Invoice Requirement in the `NOT_FOUND`
or `NEEDS_REVIEW` state. It is not itself an entity.

---

## 8.3 Missing Invoice Report

The Missing Invoice Report is a derived view of the Workspace's current invoice-reconciliation state.

It identifies transactions/expected invoices for which a satisfactory Invoice relationship has not been established.

The report must update when an invoice is:

- retrieved,
- manually uploaded,
- automatically matched,
- manually linked,
- or otherwise successfully reconciled.

For example:

```text
Before:
12 expected
8 resolved
4 missing

After one successful manual upload:
12 expected
9 resolved
3 missing
```

---

# 9. Core Business Rules

## Rule 1 — Workspace isolation

A User may have multiple Workspaces/Businesses.

Financial data belonging to one Workspace must not be treated as belonging to another Workspace.

---

## Rule 2 — Uploading a document does not establish an invoice

Uploading an Invoice Document does not by itself establish that the document is an Invoice or that it has been reconciled.

---

## Rule 3 — Classification, extraction, and reconciliation are separate decisions

The system may:

- identify a document as an invoice but fail to extract sufficient information,
- extract invoice information but fail to identify its transaction,
- identify a likely transaction but require user confirmation.

These outcomes must remain distinguishable.

---

## Rule 4 — One Invoice maps to at most one Transaction

An Invoice cannot be reconciled against multiple Transactions in V1.

---

## Rule 5 — One Transaction maps to at most one Invoice

A Transaction cannot have multiple Invoice relationships in V1.

---

## Rule 6 — Vendor identity is normalized

Legal names, trade names, aliases, and payment-provider representations may refer to the same Vendor.

Vendor identity therefore cannot depend solely on exact string equality.

---

## Rule 7 — Amount is strong evidence, not sufficient evidence

Invoice amount should contribute strongly to reconciliation, but an amount match alone does not necessarily establish the Invoice-to-Transaction relationship.

Currency differences must be considered.

---

## Rule 8 — Dates are evidence, not necessarily exact equality

Invoice dates and transaction dates may differ because of payment processing, settlement, or other legitimate timing differences.

---

## Rule 9 — User confirmation is authoritative

When automatic reconciliation cannot establish a sufficiently reliable relationship, the Business Owner may manually link the Invoice to a Transaction.

That explicit decision establishes the relationship.

---

## Rule 10 — Failed automation does not prevent manual resolution

OCR failure, extraction failure, invoice-classification uncertainty, or automatic matching failure must not prevent the Business Owner from manually linking the Invoice Document to a Transaction.

---

## Rule 11 — Duplicate invoice documents should not silently create duplicate invoices

If the same underlying Invoice is retrieved from a Google Account and subsequently uploaded manually, Muneem Ji should recognize the possibility that both documents represent the same Invoice.

The user should be able to review and resolve the duplicate.

---

## Rule 12 — Missing Invoice is resolved through reconciliation

A Missing Invoice ceases to be missing when a satisfactory Invoice-to-Transaction relationship has been established.

This may occur automatically or through explicit user confirmation.

---

# 10. Domain Invariants

The following should remain true regardless of implementation:

1. A User can have multiple Workspaces/Businesses.
2. A Workspace's financial data belongs exclusively to that Workspace.
3. A Bank Account belongs to a Workspace.
4. A Transaction belongs to a Bank Account.
5. An Invoice belongs to a Workspace.
6. An Invoice is associated with a Vendor.
7. An Invoice may have multiple Invoice Documents.
8. An Invoice may be linked to at most one Transaction.
9. A Transaction may be linked to at most one Invoice.
10. Uploading a document does not automatically establish reconciliation.
11. Failed automated processing does not prevent manual resolution.
12. A Missing Invoice is derived from the absence of a satisfactory Invoice-to-Transaction relationship.
13. Successfully resolving an Invoice Requirement must cause the Missing Invoice Report to reflect the updated state.
14. A Statement Line belongs to exactly one Bank Statement and is never modified after extraction.
15. A Canonical Transaction is derived from one or more Statement Lines of the same Bank Account.
16. At most one Invoice Requirement exists per Canonical Transaction.
17. A Canonical Transaction may hold several Supporting Documents but at most one Invoice.
18. Business Knowledge is created only from a user's confirmed decision.
19. Every Workspace-scoped entity is reachable from exactly one Workspace.

---

# 11. Deliberately Out of Scope

This domain model does not define:

- Database tables or schema
- API endpoints
- Frontend architecture
- OCR providers
- LLM providers/models
- Prompt design
- Agent architecture
- Matching algorithms
- Confidence thresholds
- Reconciliation scoring
- Background job infrastructure
- Event queues
- Authentication implementation
- File storage implementation
- Gmail API implementation
- Exact Subscription detection logic

These belong to subsequent technical design.

## 11.1 Out of product scope for V1

Distinct from the above: these are product decisions, not deferred design.

- **Sales invoices.** An Invoice is a charge _from_ a Vendor _to_ the Workspace. Invoices
  the business issues to its own customers are out of scope.
- **Refunds and credit notes.** Incoming credits and refunds are recorded as Canonical
  Transactions but do not generate Invoice Requirements in V1.
- **Multi-user Workspaces.** A Workspace has exactly one user in V1. There are no
  members, roles, or invitations.
- **Non-Gmail invoice sources.** See `docs/architecture.md §12`.

### Cross-currency comparison

Several workflows compare an invoice in one currency against a transaction in another.

**Settled:** these rates serve **match scoring only**. They never produce a booked figure.
Currency mismatch is weak corroborating evidence within a wide tolerance band, never a
standalone match test, so precision is not the binding constraint — any reasonably current
source with historical daily rates is sufficient.

The vendor is chosen when the reconciliation-scoring slice is built. It is a five-minute
decision at implementation time and is deliberately not locked here.

**Revisit if a foreign-currency invoice is ever booked into an actual ledger entry** — not
merely matched against a transaction, but converted into a figure that lands in a client's
accounts.

That is a different problem with a different standard. Indian accounting practice expects a
consistent, defensible rate for booked conversions, and the rate should be RBI-anchored. A
source chosen for convenience inside a matching heuristic will not hold up there.

The failure to avoid is having two exchange rates in the system answering the same question
differently. If booking is introduced, the booked rate is authoritative and matching adopts
it; matching does not keep its own.

---

# 12. Current V1 Scope

Muneem Ji V1 currently models:

- Users
- Workspaces/Businesses
- Bank Accounts
- Bank Statements
- Transactions
- Invoices
- Invoice Documents
- Vendors
- Subscriptions
- Google Accounts
- Statement Lines and Canonical Transactions
- Statement Coverage
- Supporting Documents
- Invoice Requirements
- Reconciliation Runs
- Business Knowledge
- Clarification Questions

The primary financial relationship is:

```text
Workspace
    ↓
Bank Account
    ↓
Transaction
    ↕
Invoice
    ↓
Vendor
```

with Invoice Documents representing the underlying Invoice and Google Accounts providing the current automated invoice-retrieval source.
