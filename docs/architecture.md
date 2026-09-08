# Muneem Ji — Architecture

## 1. Purpose

This document defines the software architecture for Muneem Ji V1.

It describes how the domain model is implemented as a software system, including:

- major system components
- responsibilities and boundaries
- data ownership
- synchronous and asynchronous processing
- document processing
- AI usage
- reconciliation
- integrations
- failure handling
- security and workspace isolation
- technology choices

This document is intentionally independent of individual implementation details such as database table schemas, API route names, prompts, or UI component structure.

Concept names used here are defined in `docs/glossary.md`; state names in
`docs/state-machines.md`.

The goal of the V1 architecture is to automate invoice identification, retrieval, processing, and reconciliation as reliably as possible while preserving original documents and providing a manual path whenever automation is uncertain or fails.

---

# 2. Architectural Principles

Muneem Ji follows these principles.

### 2.1 Original documents are the source of truth

Uploaded or retrieved invoice documents must be preserved independently of extracted invoice information.

OCR, parsing, and LLM extraction can be wrong.

The original document must remain available for human review and reprocessing.

### 2.2 The database is the source of truth for application state

The database records authoritative domain state such as:

- users
- workspaces
- bank accounts
- transactions
- invoices
- invoice documents
- vendors
- subscriptions
- Google accounts
- processing states
- reconciliation relationships

AI output does not directly become authoritative domain state without validation and application logic.

### 2.3 AI provides inference, not authority

AI may:

- extract information
- interpret unfamiliar documents
- identify vendors
- generate candidate matches
- reason about ambiguous evidence

AI does not independently determine authoritative business state.

The application validates AI output and applies business rules.

Where uncertainty remains, the user makes the final decision.

### 2.4 Automation must have a manual escape hatch

Failure of OCR, extraction, retrieval, or reconciliation must not make an invoice impossible to resolve.

The system must preserve the original document and allow the user to manually link it to a transaction where appropriate.

### 2.5 Long-running work is asynchronous

Operations such as:

- Gmail searches
- downloading invoices
- document processing
- OCR
- extraction
- reconciliation
- large bank statement processing

should run as background workflows where appropriate.

The user should not need to keep the browser open while these operations execute.

### 2.6 Domain rules are enforced by the application

Important invariants such as:

- workspace isolation
- one invoice ↔ at most one transaction
- one transaction ↔ at most one invoice
- valid state transitions
- duplicate protection

must be enforced by application and database constraints rather than relying on AI behavior.

### 2.7 Business knowledge is explicit and persistent

When the system learns something valuable from a user's confirmed decision, that knowledge should be stored as structured domain information.

For example:

```text
Workspace
└── Vendor: Adobe
    ├── ADOBE
    ├── ADOBE INC
    └── RAZORPAY*ADOBE
```

This is preferable to relying on opaque model memory.

---

# 3. System Boundary

Muneem Ji consists of the following major components:

```text
                    ┌─────────────────┐
                    │  Business Owner │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    Web App      │
                    │    Next.js      │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Application     │
                    │ Backend         │
                    └───────┬─┬───────┘
                            │ │
                 ┌──────────┘ └──────────┐
                 ▼                       ▼
        ┌────────────────┐       ┌────────────────┐
        │  PostgreSQL    │       │ File Storage   │
        │                │       │                │
        │ Domain State   │       │ Original Docs  │
        └────────────────┘       └────────────────┘
                 ▲
                 │
                 │
        ┌────────┴─────────┐
        │ Background       │
        │ Workflows        │
        │ Inngest          │
        └───────┬──────────┘
                │
       ┌────────┼───────────────┐
       ▼        ▼               ▼
    Gmail   Document        AI / LLM
            Processing
```

The architecture is intentionally a modular application rather than a collection of microservices.

V1 should favor clear boundaries and simple deployment over distributed-system complexity.

---

# 4. Major Components

## 4.1 Web Application

### Technology

Next.js.

### Responsibilities

The web application:

- provides the user interface
- handles user interactions
- displays application state
- allows uploads
- displays missing invoice reports
- displays processing status
- presents reconciliation decisions requiring user review
- allows manual invoice linking
- allows users to manage their workspaces and integrations

The web application does not own authoritative domain state.

It reads and mutates state through the application backend.

---

## 4.2 Application Backend

### Technology

Next.js backend/API layer for V1.

### Responsibilities

The backend is the primary application boundary between the frontend and the rest of the system.

It is responsible for:

- authorization
- validating user actions
- enforcing domain rules
- reading and writing domain state
- creating background workflows
- generating signed/private document access where required
- coordinating integrations
- exposing application state to the frontend

The backend should contain business/application logic rather than embedding business decisions inside frontend components.

---

# 5. Database

## 5.1 Technology

PostgreSQL.

## 5.2 Why PostgreSQL

Muneem Ji's domain is strongly relational.

Important relationships include:

```text
User
 └── Workspace
      ├── Bank Accounts
      │     └── Transactions
      ├── Invoices
      │     └── Invoice Documents
      ├── Vendors
      ├── Subscriptions
      └── Google Accounts
```

The system also has important integrity constraints.

For example:

```text
Transaction 1 ───── 0..1 Invoice
Invoice     1 ───── 0..1 Transaction
```

A relational database allows these relationships and constraints to be represented explicitly.

PostgreSQL is therefore the V1 database.

### Which PostgreSQL

V1 uses **Neon**, in `aws-ap-southeast-1` (Singapore). Postgres and nothing else — no
bundled authentication, no bundled storage. See
`docs/decisions/0005-neon-authjs-blob.md`, including the Indian data residency this
knowingly trades away.

This has one consequence worth stating plainly: workspace isolation is enforced by the
**application layer**, in the backend described in section 4.2 — not by Postgres row-level
security. Every query is scoped to a workspace by application code, and the backend is the
only component holding database credentials. The frontend never talks to the database
directly, so there is no client-side query surface for RLS to defend.

That is a deliberate trade. It keeps authorization in one readable place instead of split
across policies and code, and it means the isolation invariant is testable with ordinary
tests. It also means a single missing workspace filter is a data leak, so:

- every table holding workspace-scoped data carries a workspace column,
- data access goes through a layer that requires a workspace to be supplied,
- isolation is covered by tests that attempt cross-workspace access and expect failure.

Adding RLS later as a second line of defence remains possible and does not require
rearchitecting.

## 5.3 Database Responsibilities

The database owns structured application state.

It stores:

- users
- workspaces
- bank accounts
- transactions
- invoices
- invoice documents and their metadata
- vendors
- subscriptions
- Google account metadata
- processing state
- reconciliation state
- persisted business knowledge
- workflow-related domain state
- statement lines and canonical transactions
- statement coverage
- invoice requirements
- reconciliation runs
- clarification questions and their answers

The database does **not** store the actual binary contents of uploaded documents.

---

# 6. File Storage

## 6.1 Technology

Vercel Blob, using private access.

Documents are never publicly readable and are served through authorized application routes
(section 19). See `docs/decisions/0005-neon-authjs-blob.md`.

## 6.2 Responsibilities

File storage owns the actual contents of:

- uploaded PDFs
- uploaded invoice images
- retrieved invoice documents
- other source documents required by the V1 workflows

The database stores metadata and references to these objects.

Conceptually:

```text
Database
└── Invoice Document
      ├── storage reference
      ├── filename
      ├── MIME type
      ├── processing state
      └── extraction metadata

Storage
└── Actual PDF/Image bytes
```

This separation is deliberate.

The database represents what the document means to Muneem Ji.

Storage preserves what the document actually was.

---

# 7. Background Workflows

## 7.1 Technology

Inngest.

## 7.2 Responsibilities

Inngest handles durable background execution for workflows that may be:

- slow
- multi-step
- retryable
- externally dependent
- capable of failing independently

Examples include:

```text
Bank Statement Upload
        ↓
Parse
        ↓
Validate
        ↓
Persist Transactions
        ↓
Identify Invoice Requirements
        ↓
Retrieve Invoices
        ↓
Process Documents
        ↓
Reconcile
```

Individual workflows may contain multiple steps.

The browser does not need to remain open while these workflows execute.

## 7.3 Why Inngest

Inngest provides V1 with:

- background execution
- retries
- durable workflow execution
- event-driven triggering
- visibility into workflow runs
- multi-step workflows

This is preferable to implementing custom job infrastructure for V1.

---

# 8. Document Processing Architecture

Document processing is deliberately layered.

The system should not assume that every document requires the same technique.

The processing pipeline is:

```text
Original Document
       ↓
File Validation
       ↓
Document Type / Characteristics
       ↓
Text Extraction where possible
       ↓
OCR / Document Understanding if required
       ↓
Structured Extraction
       ↓
Validation
       ↓
Invoice Domain Data
```

## 8.0 Bank statement parsing

Bank statements follow a specific rule, fixed by
`docs/decisions/0003-llm-for-structure-not-values.md`: a model identifies **structure**, and
code reads **values**.

For CSV and text-based PDFs, a model maps the file's columns to a fixed internal vocabulary
from a small sample, and deterministic code then walks every row using that mapping. The
model never reports a number that reaches the database.

Scanned statements have no embedded text, so a model reads values directly. That path is
acknowledged as higher-risk and its balance mismatches go to manual review rather than
retry.

There are no per-bank parsers.

## 8.1 Deterministic processing first

Where reliable deterministic methods exist, they should be preferred.

For example:

- extracting text from a text-based PDF
- validating file types
- reading structured data
- identifying pages
- storing documents
- validating required fields
- querying candidate transactions

This is cheaper, faster, and more predictable than using an LLM for every operation.

## 8.2 OCR fallback

If a PDF contains no usable text, or the document is an image/photo, OCR or multimodal document understanding is required.

The exact OCR provider is intentionally not hard-coded into the architecture.

The provider will be selected empirically using representative invoice samples.

## 8.3 LLM extraction

An LLM may be used when:

- document layouts vary significantly
- semantic interpretation is required
- OCR output needs interpretation
- fields are represented differently across vendors
- the document is unfamiliar

The architecture must not directly trust:

```text
Document → LLM → Database
```

Instead:

```text
Document
   ↓
OCR / Text / Document Understanding
   ↓
LLM Structured Extraction
   ↓
Schema Validation
   ↓
Business Validation
   ↓
Application State
```

---

# 9. AI Architecture

AI is a supporting reasoning layer rather than the system's authority.

## 9.1 Appropriate AI responsibilities

AI may be used for:

- unfamiliar document interpretation
- invoice field extraction
- semantic vendor identification
- vendor alias inference
- reconciliation reasoning
- interpreting ambiguous descriptions
- identifying likely invoice candidates

## 9.2 Responsibilities that should remain deterministic

The application should handle:

- file validation
- storage
- database operations
- workspace authorization
- transaction queries
- state transitions
- one-to-one invoice/transaction constraints
- missing invoice derivation
- duplicate protection
- user confirmation
- persistence of confirmed decisions

## 9.3 AI output must be structured

AI calls should produce structured data conforming to an explicit schema.

The application validates that output before using it.

The system should avoid allowing free-form model responses to directly mutate domain state.

---

# 10. Reconciliation Architecture

Invoice reconciliation uses a hybrid approach.

It should not send every invoice and every transaction to an LLM.

## Stage 1 — Candidate Generation

The application deterministically narrows the search space using evidence such as:

- workspace
- transaction direction
- amount
- currency
- date range
- vendor information
- transaction description
- known relationships

## Stage 2 — Reasoning

AI may evaluate the remaining candidates using semantic evidence such as:

- vendor aliases
- payment-provider descriptions
- invoice numbers
- merchant names
- date discrepancies
- currency representation
- contextual relationships

## Stage 3 — Decision Policy

The application determines the outcome.

Conceptually:

```text
Strong evidence
      ↓
Automatic match

Ambiguous evidence
      ↓
User review

Insufficient evidence
      ↓
Remain unmatched
```

The exact confidence threshold is an empirical decision and will be established through evaluation rather than guessed in the architecture.

## 10.1 Evidence-based confidence

The system should not rely solely on an LLM saying:

> confidence = 95%

Confidence should be derived from observable evidence.

Potential signals include:

- vendor match
- known vendor alias match
- amount match
- currency match
- date proximity
- invoice number match
- transaction description similarity
- historical confirmed relationships

The exact scoring system is an implementation/evaluation concern.

---

# 11. Business Knowledge

Muneem Ji should persist useful knowledge learned through user-confirmed actions.

Examples include:

- vendor aliases
- vendor representations in transaction descriptions
- confirmed vendor relationships
- other workspace-specific identification patterns

The distinction is:

```text
AI inference
     ↓
Suggestion

User confirmation
     ↓
Authoritative business knowledge
```

Unconfirmed model guesses should not automatically become permanent business facts.

This allows Muneem Ji to improve within a workspace without relying on opaque model memory.

---

# 12. Gmail Integration

## 12.1 V1 Source

Google Gmail is the only automatic invoice source supported in V1.

## 12.2 Connection

The user is prompted during onboarding to connect a Google account.

Muneem Ji obtains the permissions required to search for and retrieve relevant invoice emails/documents.

## 12.3 Integration Boundary

Gmail access should be isolated behind an invoice-source/integration boundary.

The core invoice domain should not depend directly on Gmail-specific concepts.

Conceptually:

```text
Invoice Retrieval Workflow
          ↓
Invoice Source Interface
          ↓
       Gmail
```

This allows additional invoice sources to be introduced later without redesigning the invoice domain.

## 12.4 Google Credentials

OAuth credentials/tokens must be stored securely.

Access to Gmail must be scoped to the relevant user/workspace and must not expose data between workspaces.

---

# 12A. Notifications

Two workflows require reaching a user who is not in the application: a clarification
question raised while they are away (`docs/workflows/identifying-invoices.md §5`), and a
long reconciliation finishing.

Notification is therefore a component, not an afterthought.

For V1:

- **Email** is the only channel.
- Notifications are **batched, not per-event**. One "your reconciliation is ready, 7 things
  need you" is useful; seven emails are a reason to disable notifications.
- Notification state is persisted, so a notification is sent once and never twice.
- Nothing in the pipeline blocks on a notification being delivered.

Administrator alerting for non-recoverable internal failures — required by two workflows —
is separate from user notification and goes to the operator, never to the user.

---

# 12B. Report Export

Excel export (`docs/workflows/missing-invoice-report.md §9`) is a background workflow, not
a request handler. A workspace with tens of thousands of transactions cannot be exported
inside an HTTP request.

```text
User requests export
        ↓
Backend records the request, returns immediately
        ↓
Inngest workflow builds the file from current domain state
        ↓
File written to Vercel Blob
        ↓
User notified / download offered
```

The generated file is a **snapshot**, not a live view: it reflects the state at generation
time, and re-requesting produces a fresh one.

Document references inside the export are links back into the application, never storage
URLs — see section 19 and the workflow document for why.

Generated exports are stored with the same privacy rules as source documents — private
access, served through authorized routes — and are subject to expiry, since they are
derived data and can always be regenerated.

---

# 12C. Human-in-the-Loop Workflows

Several workflows pause for a person. That is a first-class architectural requirement, not
an exception path.

Two mechanisms, chosen by how long the wait is:

**Short, bounded waits** — a workflow step that can reasonably expect an answer within its
own execution — use Inngest's wait-for-event support, resuming when the answering event
arrives, with a timeout that continues without the answer rather than hanging.

**Open-ended waits** — a clarification question a user may answer next week, or a
requirement sitting in `NEEDS_REVIEW` — do **not** hold a workflow open. The question is
persisted as domain state, the workflow completes, and the user's answer later triggers a
new event.

The distinction matters: a durable workflow waiting a week is a workflow that will be lost
to a deploy, a timeout, or a retry policy. Anything a human might take days to answer
belongs in the database, not in a suspended execution.

This is why Clarification Question and Invoice Requirement are persisted entities
(`docs/domain-model.md §3.12`, `§3.15`). Their state _is_ the pause.

---

# 13. Asynchronous Processing

The system distinguishes between operations that should respond immediately and operations that should execute in the background.

### Synchronous

Examples:

- authentication
- displaying dashboard data
- creating a workspace
- initiating an upload
- requesting a manual link
- confirming a reconciliation decision

### Asynchronous

Examples:

- parsing large statements
- Gmail searches
- downloading invoices
- OCR
- invoice extraction
- reconciliation
- generating/updating missing invoice information
- generating the Excel export
- sending notifications

The general pattern is:

```text
User Action
    ↓
Backend validates action
    ↓
Persist initial state
    ↓
Trigger background workflow
    ↓
Workflow processes data
    ↓
Persist resulting state
    ↓
Frontend observes updated state
```

---

# 14. Frontend Processing Updates

The frontend should reflect persisted processing state rather than maintaining an independent representation of workflow truth.

V1 uses **polling**.

It is sufficient for work measured in seconds to minutes, and it adds no infrastructure.
A push mechanism can replace it later without changing the requirement below.

The architectural requirement is:

```text
Workflow state
      ↓
Database
      ↓
Frontend
```

rather than:

```text
Workflow state
      ↓
Frontend-only state
```

This allows users to refresh or return to the application without losing visibility into processing progress.

---

# 15. Failure Handling

Failures are represented as state rather than silently discarded.

For example:

```text
Invoice Document
      ↓
OCR
      ↓
FAILED
```

The document still exists.

The user can then:

```text
Retry
  OR
Review
  OR
Manually link
```

Similarly, if invoice extraction fails:

```text
Original Document
      +
Extraction Failed
      ↓
Manual Resolution Available
```

Automation failure must never imply document loss.

---

# 16. Idempotency and Duplicate Protection

Background workflows may be retried or accidentally triggered more than once.

Therefore, processing must be designed to be idempotent.

Repeated execution must not silently create:

- duplicate transactions
- duplicate invoices
- duplicate invoice documents
- duplicate Gmail retrieval results
- duplicate reconciliation relationships

Important workflows requiring duplicate protection include:

- bank statement ingestion
- Gmail invoice retrieval
- manual invoice upload
- OCR processing
- invoice extraction
- reconciliation

An invoice document retrieved from Gmail and the same invoice later uploaded manually should be capable of being recognized as a possible duplicate.

The system should ask the user to review ambiguous duplicates rather than silently creating a second invoice.

---

# 17. Invoice and Document Model Boundary

An invoice and its documents are separate concepts.

```text
Invoice
 ├── Invoice metadata
 ├── Vendor
 ├── Amount
 ├── Date
 ├── Invoice number
 └── Transaction relationship

Invoice Documents
 ├── Original PDF
 ├── Page/image information
 └── Processing state
```

An invoice may have multiple documents.

A document may be:

- retrieved from Gmail
- manually uploaded
- multi-page
- an image
- a PDF

Uploading a document does not automatically establish that a valid invoice exists.

The processing pipeline must first determine:

```text
Document
   ↓
Is this an invoice?
   ↓
Extract invoice information
   ↓
Create or associate Invoice
```

---

# 18. Missing Invoice Report

The Missing Invoice Report is a derived view rather than an independent source of truth.

It is derived from domain state and expected-invoice logic.

Conceptually:

```text
Invoice Requirements
       ↓
Existing / Retrieved / Uploaded Invoices
       ↓
Reconciliation State
       ↓
Missing Invoice Report
```

The report should update after relevant state changes, including:

- successful Gmail retrieval
- successful manual upload
- successful invoice extraction
- successful reconciliation
- manual invoice-to-transaction linking

A missing invoice is considered resolved when a satisfactory invoice-to-transaction relationship exists according to the V1 business rules.

---

# 19. Security and Workspace Isolation

The fundamental authorization boundary is:

```text
User
  ↓
Workspace
  ↓
Domain Data
  ↓
Documents / Integrations
```

A user's workspaces are isolated from one another.

Every operation involving:

- transactions
- invoices
- documents
- vendors
- subscriptions
- bank accounts
- Google accounts

must be authorized against the relevant workspace.

Documents are stored privately.

Document access should be mediated through authorized application flows rather than publicly exposed storage URLs.

Google credentials must also be protected and scoped appropriately.

---

# 20. Technology Decisions

The current V1 architecture uses:

| Concern                  | V1 Decision                                       |
| ------------------------ | ------------------------------------------------- |
| Web application          | Next.js                                           |
| Backend                  | Next.js backend/API                               |
| Database | PostgreSQL on Neon (ap-southeast-1) |
| File storage | Vercel Blob (private) |
| Background workflows     | Inngest                                           |
| Automatic invoice source | Gmail API                                         |
| Document processing      | Hybrid                                            |
| PDF text extraction      | Deterministic extraction where possible           |
| OCR                      | Provider selected through evaluation              |
| LLM                      | Provider/model selected through evaluation        |
| Reconciliation           | Deterministic candidate generation + AI reasoning |
| Authentication | Auth.js, Google first |
| Excel export | Background workflow (Inngest) → Vercel Blob |
| Processing updates | Polling |

The architecture is locked at the category level even where the exact provider/model remains subject to evaluation.

---

# 21. Decisions That Require Evaluation Rather Than Architecture

The following should **not** be decided by intuition alone.

## 21.1 OCR provider

Evaluate representative documents including:

- clean PDFs
- scanned PDFs
- photographs
- poor-quality images
- different invoice layouts
- multi-page invoices

Measure extraction quality and reliability.

## 21.2 LLM/provider

Evaluate:

- invoice field extraction accuracy
- structured-output reliability
- unfamiliar invoice layouts
- ambiguous vendor names
- reconciliation reasoning
- latency
- cost

## 21.3 Reconciliation scoring

Build a representative evaluation set containing:

```text
Invoice
Transaction
Correct match
Incorrect candidates
No valid match
Ambiguous cases
```

Measure:

- precision of automatic matches
- recall
- false-positive rate
- user-review rate

The cost of a false positive is particularly important because incorrectly attaching an invoice to the wrong transaction is worse than asking the user for help.

## 21.4 Confidence thresholds

Thresholds should be selected based on measured performance.

They should not be arbitrarily chosen because an LLM reports a particular confidence number.

---

# 22. V1 Architecture Non-Goals

V1 will not introduce:

- microservices
- multiple databases
- a custom distributed job system
- multiple invoice-source integrations
- fully autonomous agent behavior
- an LLM-controlled database
- opaque long-term model memory
- complex event-sourcing infrastructure
- custom real-time infrastructure unless required
- premature optimization

The goal is a reliable, understandable system.

---

# 23. Architectural Mental Model

The system can be understood as five layers:

```text
┌─────────────────────────────────────┐
│             User / UI               │
│              Next.js                │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│         Application Layer           │
│   Authorization + Business Logic   │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│             Domain State            │
│             PostgreSQL              │
└──────────────────┬──────────────────┘
                   ↓
┌─────────────────────────────────────┐
│         Background Processing       │
│               Inngest               │
└──────────────┬──────────┬───────────┘
               ↓          ↓
       ┌────────────┐  ┌────────────┐
       │ Processing │  │ AI / LLM   │
       │ + Gmail    │  │ Reasoning  │
       └────────────┘  └────────────┘

             Original Documents
                    ↓
               Vercel Blob
```

The most important mental model is:

> **The database records what Muneem Ji knows. Storage preserves what actually happened. Background workflows perform the work. AI provides inference. Application logic enforces the rules. The user resolves uncertainty.**

---

# 24. Architectural Goal

Muneem Ji V1 should maximize reliable automation without sacrificing correctness or recoverability.

The architecture therefore deliberately follows:

```text
Automate when reliable
        ↓
Use AI when interpretation is required
        ↓
Validate AI output
        ↓
Persist authoritative state
        ↓
Ask the user when uncertain
        ↓
Preserve the original document regardless
```

This architecture is considered **locked for V1**.

Future changes should be made only when new product requirements, evaluation results, or implementation constraints provide a concrete reason to change an architectural decision.
