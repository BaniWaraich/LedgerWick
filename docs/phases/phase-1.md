# Phase 1 — Definition & Development Strategy

## Context

The product definition is complete: seven specification documents, seven decision records, a
glossary, an authoritative state-machine reference, a schema with the domain invariants expressed
as database constraints, a workspace-scoped data access layer with isolation tests written as
attacks, and eleven wireframes with a design system.

What did not exist is a **phase boundary**. The specs describe V1 as a whole and say nothing about
what the first shippable version contains, in what order it gets built, or how the work is cut so
an AI coding agent can hold one piece in context at a time.

This document is that boundary: what Phase 1 is, how it decomposes into features, in what order
they should be built, and what we deliberately refuse to plan yet. It is not an implementation plan
and contains no engineering tickets.

Two scope calls are settled:

- **Gmail connect + retrieval are inside Phase 1.** The full automated spine.
- **All three parsing paths are inside Phase 1**: CSV, text-based PDF, and scanned PDF.

---

## 1. Understanding of the existing system

### The product

An invoice-to-bank-transaction reconciliation tool for small business owners (India-first).
Internal name **Muneem Ji**; the customer-facing name is **Ledgerwick**. The problem it solves:
a business owner has bank statements full of payments and no reliable idea which of those
payments lack a supporting document for their accounts — and finding those documents means
digging through email.

### The primary user journey

Sign in → create a workspace → connect Gmail → upload bank statements → the system parses them,
works out which payments need documentation, searches the mailboxes, and matches what it finds →
the user resolves what automation could not → download an Excel reconciliation.

### The domain, in one paragraph

A **Workspace** is the authorization boundary. A **Bank Statement** produces immutable
**Statement Lines**, which are promoted exactly once into **Canonical Transactions** — the
business's single record of each financial movement, and the only thing later workflows reason
about. Each canonical transaction may carry at most one **Invoice Requirement**, a persisted
entity with a state machine that is the unit of work for retrieval and the row shown in the
report. Any file entering the system is a **Supporting Document** first; only some are classified
and extracted into **Invoices**. A **Reconciliation Run** records one execution of the pipeline.
**Business Knowledge** is durable fact learned only from a user's confirmed decision.
**Clarification Questions** persist because the user may be away when they are raised.

### Architecture

Next.js app + API on Vercel; Neon Postgres via Drizzle; Vercel Blob (private) for document bytes;
Inngest for durable background workflows; Auth.js with Google for identity, with the restricted
`gmail.readonly` scope requested **incrementally** at mailbox-connect time, never at sign-up;
polling for processing updates. Five load-bearing principles run through everything: original
documents are the source of truth; the database is authoritative for state; AI infers but never
decides; automation always has a manual escape hatch; workspace isolation is enforced in
application code, so a single missing filter is a data leak.

The signature technical decision is ADR 0003: **a model identifies structure, code reads values.**
No per-bank parsers. For CSV and text PDFs the model maps columns once per file and deterministic
code walks every row. For scanned PDFs the model does read values — an explicitly higher-risk path
whose balance mismatches go to manual review and are never retried into acceptance.

### The codebase today

A skeleton plus one real layer. `src/db/schema.ts` implements sixteen tables with the invariants as
partial unique indexes; `src/db/workspace-scope.ts` makes the workspace an object you must hold to
reach data at all (`insert` injects `workspaceId` rather than accepting it); `tests/db/` contains
isolation tests written as attacks and constraint tests asserted by SQLSTATE and constraint name,
running on PGlite. The app itself is a landing page and three stub pages. There is no auth, no
storage module, no Inngest, no LLM call, no fixtures directory. CI runs typecheck, lint, format,
test, build, plus an advisory hygiene job and gitleaks.

### Findings that affect how Phase 1 should be defined

None of these require redesign. All are gaps to close inside the feature that needs them.

1. **Gmail connection has no table and no entry in `state-machines.md`.** `connect-gmail.md §7`
   defines `CONNECTED` / `NEEDS_REAUTH` / `DISCONNECTED`, but the authoritative state document
   does not list them and the schema has no connection entity. Close both when that feature is
   built — the state document is the contract.
2. **Auth.js session tables do not exist.** ADR 0006 requires a migration for them, and is
   explicit that they must **not** be added to `workspaceScopedTables`.
3. **Match candidates have nowhere to live.** `invoice-match-review.md §5` requires showing each
   candidate with the evidence that produced it, and `retrieve-invoices.md §21` requires retaining
   candidate emails and documents. The only trace in the schema is
   `invoice_requirements.rejected_document_ids`. A candidate/evidence record is a real gap.
4. **Notification state has no entity**, though `architecture.md §12A` requires notifications be
   persisted so one is sent once and never twice.
5. **Generated exports have no entity**, though `§12B` requires a stored snapshot subject to expiry.
6. **Subscriptions are named but undefined.** In the domain model and architecture; no table, and
   the rules are explicitly deferred. Keep out of Phase 1.
7. **A vendor guess has nowhere to attach to a transaction.** `vendors` links to `invoices`, not
   to canonical transactions; identification's vendor inference currently has only the free-text
   `invoice_requirements.reason`. Decide when identification is built.
8. **The report's counting contract vs. run counts.** `missing-invoice-report.md §3` says the
   report "computes nothing of its own", while `§5` requires matched + not found + needs review to
   sum to documents required — and requirement state keeps changing after a run ends. Resolve as:
   counts are computed live from Invoice Requirement state; the Run supplies coverage, accounts and
   identity. Note it in the report feature rather than leaving it to be discovered.
9. **No eval harness and no `fixtures/` directory exist**, though `testing-strategy.md` makes them
   the most valuable test asset in the repository, and ADR 0003 makes column-mapping accuracy on
   awkward real statements the first concrete eval target.
10. **Stale CI comment.** The hygiene job still says the audit is expected to fail "until the Next
    16 upgrade"; `package.json` is already on Next 16.3.4 and ADR 0002 is marked Resolved.

### The one risk that is schedule, not scope

`gmail.readonly` is a **Restricted** scope. Google's CASA assessment is a third-party audit with
real cost and weeks of lead time, and `connect-gmail.md §5` still carries an unresolved **OPEN
DECISION** about whether to use the Gmail API at all. Development proceeds fine against a test
account under an unverified app — but no external user can use retrieval until that clears.

**Treat verification as a parallel track started on day one, not as something the Gmail feature
discovers.** It does not change the Phase 1 boundary; it changes when Phase 1 can meet a stranger.

**Corrected once the track was actually started.** The track is two halves, and only one of them
is parallel. The consent screen, the verified domain, and the published privacy policy and terms
can all be done at A, and were. The **demo video cannot be**: Google requires it to show the real
production app demonstrating *how the data from each requested scope is used*, which means filming
a mailbox search that produces a real invoice match. That is J and K — the tenth and eleventh
features — plus enough of C, D and E for a transaction to exist and be known to need a document.

So the CASA clock does not start at A. **It starts when K ships**, and the weeks of lead time run
from there, with nothing available to run in parallel against them. The gap between "Phase 1 is
code-complete" and "Phase 1 can meet a stranger" is therefore the full assessment turnaround,
and it sits at the end of the phase rather than alongside it. Plan the end of Phase 1 knowing
that.

---

## 2. The core product loop

> **Statements in → the system understands what each payment was → it decides which payments owe
> a document → it finds that document, or the user supplies it → the user resolves what is left →
> a defensible reconciliation comes out.**

Two properties make it a loop rather than a pipeline, and both must work in Phase 1:

- **It re-runs without damage.** Upload more statements — overlapping ones included — and only
  genuinely new transactions produce new requirements. Deduplication happens exactly once, at
  promotion to canonical transactions.
- **It gets quieter.** Every user decision that generalizes becomes Business Knowledge, so the
  second run asks fewer questions than the first. A system that asks the same question twice tells
  the user their answers go nowhere.

The value is delivered at the point the user can say *"I now know exactly which of my payments
lack a document, and I can close each one."* Everything upstream is machinery.

---

## 3. Phase 1 as a product boundary

**Phase 1 is the complete reconciliation loop for one business owner, one workspace, over their
own real statements and their own real mailbox — automated where the specs say automated, with a
manual escape hatch at every point where automation is allowed to fail.**

### Must be in Phase 1

| #   | Capability                                                                                                                                            | Why it is required                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Google sign-in, session, workspace create/select                                                                                                      | Nothing is reachable without a `userId`; `openWorkspace` already demands one                             |
| 2   | Private document storage + authorized serving route                                                                                                   | `architecture.md §2.1` — original documents are the source of truth; nothing else can be built first     |
| 3   | Statement upload, identify, bind to account, parse (all three paths), validate, promote to canonical transactions, record coverage                    | The only input to the entire loop                                                                        |
| 4   | Durable background execution + honest processing state the frontend polls                                                                             | Every step above is too slow for a request; state must survive a refresh                                 |
| 5   | Invoice requirement identification, with clarification questions and business knowledge                                                                | This is the product's actual judgment. Without it there is no reconciliation, only a transaction list    |
| 6   | Document understanding: classify → extract → normalize vendor                                                                                         | Both entry paths converge here; neither may skip it                                                      |
| 7   | Manual document upload and evidence-based matching                                                                                                    | The escape hatch the architecture makes mandatory, and the path with no external dependency              |
| 8   | Gmail connection: incremental consent, encrypted credentials, connection health, reauth, disconnect                                                    | The confirmed Phase 1 boundary                                                                           |
| 9   | Gmail retrieval: search across all connected accounts, evaluate candidates, auto-associate on strong evidence, `NEEDS_REVIEW` otherwise                | The headline automation                                                                                  |
| 10  | Match review and resolution — every method, including `NOT_REQUIRED`                                                                                  | Every uncertain path in the system terminates here                                                       |
| 11  | Missing Invoice Report: summary, counting contract, action queue, blocked banner                                                                      | Where the user learns what remains                                                                       |
| 12  | Excel export as a background snapshot with links back into the app                                                                                    | The artifact the user's accountant actually receives                                                     |

### Could be in Phase 1, but shouldn't

Each is defensible and each would widen the phase without making the loop truer.

- **Subscription detection and modelling.** Named in the domain model, rules explicitly undefined.
  Requires recurrence data across many months that no early user will have.
- **Email notifications.** Real value only once the user leaves and comes back; a dogfooding user
  is already in the app. Batching, dedup and delivery state are a feature's worth of work.
- **Duplicate merge UX.** Keep _detection_ (flag a suspected duplicate into `NEEDS_REVIEW`) — it
  protects domain Rule 11. Defer the side-by-side merge-and-choose-primary screen.
- **Coverage-gap reporting UI.** Store coverage in Phase 1 because canonical dedup and run scoping
  depend on it. Defer "you are missing May" as a surfaced feature.
- **Rich discrepancy review screen.** Phase 1 tells the user a statement did not reconcile, by how
  much, and lets them proceed or re-upload. A line-by-line correction tool is a product of its own.
- **Vendor and business-knowledge management screens.** Phase 1 writes both from confirmed
  decisions; browsing and editing them can wait.
- **Second Gmail account nuance beyond "it works".** Multi-account search is in the retrieval spec
  and is cheap; per-account analytics and preferences are not.
- **The eval harness as infrastructure.** Phase 1 needs _fixtures and measurements_ for column
  mapping and matching thresholds. It does not need a general harness, dashboards, or CI eval runs.

### Phase 2+

Deliberately postponed, with the spec already saying so in most cases: sales invoices; refunds and
credit notes generating requirements; multi-user workspaces, roles and invitations; non-Gmail
invoice sources; the "export with documents" zip (`missing-invoice-report.md §9`, revisit trigger
recorded); push updates replacing polling; Postgres RLS as second-line defence; cost and latency
optimization of the model paths; Option B forwarding-based ingestion for users who refuse OAuth.

---

## 4. The right feature boundary for this project

**Vertical slices, cut along the workflow documents.**

Not modules, not technical components, not screens. The reason is specific to this repository:
`docs/workflows/*.md` already are the decomposition. Each one names its actor, trigger, inputs,
states, failure modes, output, and the workflow it hands to. Each maps to one recognizable user
capability and one contiguous region of the schema. Cutting anywhere else means inventing a
structure that has to be reconciled against the specs on every task.

Two deliberate departures from a pure per-workflow cut:

- **Document understanding is its own slice**, even though it belongs to no single workflow. Both
  `retrieve-invoices.md §11.1` and `manual-invoice-upload.md §4–6` converge on it and neither may
  skip it. Building it inside whichever workflow arrives first would bury shared behaviour in a
  caller.
- **`upload-statement.md` splits in two.** It is by a wide margin the largest workflow and contains
  two genuinely separable halves: getting a file identified and bound to an account, and turning it
  into validated canonical transactions. The seam is clean — a `bank_statements` row with a bound
  account.

Everything else stays whole. Notably, do **not** split "the LLM call" from "the code that uses it",
or "the schema migration" from "the feature that needs the columns". Those are the splits that
force an agent to reconstruct the whole system to make progress.

---

## 5. Designing for AI-agent development

The constraint is context, and the specs are unusually well suited to it: an agent building one
feature should need **the glossary, the state machines, one workflow document, the relevant schema
region, and the named modules it touches** — not the repository.

What makes a feature the right size here:

- It reads **one** workflow document as its contract.
- It touches a contiguous region of the schema, usually 1–3 tables.
- It has one clear input and one clear output, both of which are persisted state.
- It can be verified by unit tests over pure functions plus an integration test over PGlite, with
  a cross-workspace isolation test wherever it touches workspace-scoped data.
- It leaves the repository green: `tsc --noEmit`, `npm test`, and the Definition of Done all pass.

Three project-specific rules that keep agent sessions cheap:

1. **The specs are the context, and they are already loaded per feature.** `AGENTS.md` maps
   document to situation. Brief an agent with the workflow document, not with a tour of the code.
2. **`docs/definition-of-done.md` is the review step.** It exists precisely because the failure
   mode of AI-assisted development is work reported as finished that was not. Every feature ends
   with a pass over it — especially the workspace-scoping and background-workflow sections.
3. **Keep the state machines closed.** An agent that needs a state that does not exist must update
   `docs/state-machines.md` in the same change. That single rule prevents most of the drift that
   would otherwise force whole-system re-reading later.

Where **not** to fragment: parse / validate / promote-to-canonical belong together — the identity
rule is meaningless without the rows it deduplicates, and splitting them produces a half-state
nothing can test. Likewise classify + extract + normalize vendor: extraction without normalization
produces data no matcher can use. Where not to over-scope: never combine two workflow documents in
one session.

---

## 6. Development philosophy

**Phase → Feature (one vertical slice, one workflow document) → Agent task (one commit).**

- **Fits the architecture** because the boundaries are already drawn — UI, application layer,
  domain state, background workflows, integrations — and a vertical slice crosses each once. The
  workspace scope object means the isolation rule travels with the slice rather than being a
  cross-cutting concern to remember.
- **Fits the product** because each slice advances one state machine from one state to the next.
  Progress is legible in the domain's own vocabulary, not in tickets.
- **Fits AI agents** because a slice's contract is a document that already exists, its acceptance
  criteria are already written as states and outputs, and its review checklist is already written.
- **Fits the git history requirement** in `AGENTS.md §8`: a slice is a small number of coherent
  commits that read as the story of how the system came to be.

Per feature, the working rhythm should be: one conversation to define the feature's tasks against
its workflow document → a short sequence of agent tasks, each one commit → a Definition of Done
pass → merge with the repository green.

---

## 7. Phase 1 feature map

Twelve features. Dependencies list only what genuinely blocks.

---

### A. Identity & Workspace Shell

**Purpose.** Google sign-in, a server-side session, and the ability to create, list and select a
workspace, with an authenticated application shell around everything else.

**Why Phase 1.** Every route derives `userId` from the session, and `openWorkspace` cannot be
called without one. Nothing else in the phase is reachable.

**Dependencies.** None. Starts here.

**Complete when.** A user signs in with Google, lands with a workspace, and every authenticated
route resolves a `WorkspaceScope` from the session — never from a client-supplied id. Sign-up
requests profile scopes only; the Gmail scope is never requested here. Auth.js tables exist and
are absent from `workspaceScopedTables`.

---

### B. Document Store & Authorized Serving

**Purpose.** One module that puts bytes into private Vercel Blob and one authorized route that
streams them back after checking session and workspace.

**Why Phase 1.** Original documents are the source of truth. Statements, retrieved attachments,
uploads, previews and the export all sit on this. It is small, and everything downstream assumes it.

**Dependencies.** A.

**Complete when.** Blobs are private and workspace-prefixed, no storage URL ever reaches the
frontend, the store is writable from a background workflow as well as a request, and a
cross-workspace fetch attempt is tested and fails.

The prefix is enforced by the type system, not by the writer remembering it: `DocumentStore.put`
accepts a branded `DocumentKey`, which only `documentKey()` in `src/storage/keys.ts` can produce,
and `tests/storage/keys-are-unavoidable.test.ts` bans the cast that would forge one. **A feature
that stores bytes builds its key with `documentKey()`. There is no other way, and widening `put`
to accept a string, or casting to get round it, is not a fix.**

---

### C. Statement Intake & Identification

**Purpose.** Upload one or more files, store them, decide whether each is a bank statement,
identify bank / account / period, and bind each to exactly one bank account in the workspace —
creating it or asking the user when the document does not say.

**Why Phase 1.** The entry point of the loop, and the feature that introduces durable background
execution and the polled processing state the rest of the phase reuses.

**Dependencies.** A, B.

**Complete when.** A statement moves `UPLOADING → IDENTIFYING` and either binds to an account or
reaches `FAILED` with a human-readable reason. This is the first feature that
writes to the document store, so it is the first to build a `DocumentKey` — via `documentKey()`
with the statement row's id as the unique segment (see B), never a hand-rolled path — and the
first to write from a background workflow rather than a request. Account lookup provably never
leaves the workspace. Files in one batch reach independent outcomes. State survives a refresh.
A statement reports a period only where the document declares one, and one that declares none
proceeds without it rather than failing — parsing derives the range, and the source of the two
is recorded. `docs/decisions/0008`.

---

### D. Statement Parsing, Validation & Canonical Promotion

**Purpose.** Turn a bound statement into statement lines and then into canonical transactions:
model-inferred column mapping plus a deterministic walker for CSV and text PDFs, a vision/OCR path
for scanned input, the balance check, and the identity rule that deduplicates exactly once.

**Why Phase 1.** This is the correctness heart of the product. Every downstream feature assumes each
financial movement appears exactly once.

**Dependencies.** C.

**Complete when.** The binary invariants in `docs/parsing-acceptance.md` hold and the
workflow runs end to end on real statements: re-uploading produces zero new canonical
transactions, overlapping statements produce one transaction with two lines, validation
sets `VALID` or `DISCREPANCY`, a scanned mismatch is never retried into acceptance, a
mapping failing its schema fails the statement, and coverage is recorded.

**Quality is a separate bar, and it does not gate this feature.** `0003` stakes the whole
design on a statement nobody has written a parser for being read correctly, and the only
evidence for that is how often it is not — a statistical property no test suite settles.
That bar is six consecutive unseen statements parsed correctly on first attempt, it is
earned across the rest of the phase rather than before E starts, and it is a condition of
**Phase 1** closing rather than of D closing. `docs/parsing-acceptance.md` holds the
criteria and the log; `BAN-146` is the standing prompt.

What this section said before was that mapping accuracy be "measured at least once".
Measuring once is an activity rather than a bar, and it was satisfied while the parser was
dropping 71% of a real statement with the suite green throughout.

---

### E. Invoice Requirement Identification

**Purpose.** Analyse canonical transactions at the business level, decide which need supporting
documentation, apply existing Business Knowledge before asking anything, persist clarification
questions without stalling, and create Invoice Requirements in `IDENTIFIED`.

**Why Phase 1.** This is the product's judgment. Without it there is no reconciliation, only a list
of transactions.

**Dependencies.** D.

**Complete when.** A reconciliation run creates at most one requirement per canonical transaction,
skips transactions already carrying one, never asks a question whose answer is already known, and
completes without waiting on a human. Zero requirements is a valid, clearly communicated outcome.
Confirmed answers become Business Knowledge; unconfirmed inferences never do. The run's output is
visible to the user as a human-readable list.

---

### F. Document Understanding

**Purpose.** Take a stored supporting document and move it through `STORED → EXTRACTING →
CLASSIFYING` to `EXTRACTED`, `UNREADABLE` or `NOT_AN_INVOICE` — text extraction with OCR fallback,
three-valued classification, field extraction, and vendor normalization.

**Why Phase 1.** Both retrieval and manual upload converge here and neither may skip it. Building
it once, entry-agnostic, is what keeps that true.

**Dependencies.** B. (Vendor normalization benefits from E's knowledge but does not block on it.)

**Complete when.** Both entry paths call one pipeline. `UNREADABLE` and `NOT_AN_INVOICE` are
outcomes, not failures — the document stays stored, is never deleted by automation, and remains
manually linkable. Classification stays three-valued and is never flattened to a boolean. Model
output is schema-validated before anything persists, and validation failure does not crash the
workflow. The binary invariants in `docs/extraction-acceptance.md` hold and the pipeline runs end
to end on real invoices.

**Quality is a separate bar, and it does not gate this feature** — the same split feature D
carries, for a stronger reason. Parsing has the balance equation; an invoice has no
arithmetic check of any kind, so `0010` can catch a misread span and nothing can catch a
span read off the wrong line. That bar is six consecutive unseen invoices understood
correctly on first attempt, it is earned across the rest of the phase, and it is a condition
of **Phase 1** closing rather than of F closing. `docs/extraction-acceptance.md` holds the
criteria and the log; `BAN-152` is the standing prompt, and `BAN-150` is the corpus it needs.

What this section said before was that OCR and model choices be "made against fixtures, with
the result recorded". That is the same "measured at least once" formulation that was
corrected for D — an activity rather than a threshold.

---

### G. Manual Upload & Matching

**Purpose.** The user uploads a document from any entry point; the system deterministically
generates a small candidate set of transactions and evaluates the evidence, producing an automatic
link, `NEEDS_REVIEW`, or no reliable match. Detects suspected duplicates.

**Why Phase 1.** The mandatory escape hatch, the highest-value path with no external dependency, and
where the matching engine that retrieval also needs actually gets built and tuned.

**Dependencies.** E, F.

**Complete when.** Candidate generation is deterministic and never asks a model to search all
transactions. Matching is evidence-based, tolerant on date and currency, and a false positive is
treated as a worse outcome than asking the user. Entry from match review skips matching entirely
because the transaction is already known. A suspected duplicate never silently creates a second
invoice. The 1:1 invariants hold under attempted violation. Thresholds are chosen from measurement,
not intuition.

---

### H. Match Review & Resolution

**Purpose.** The single screen where every uncertain path terminates: show the transaction, what the
system did, and the candidates with their evidence; capture the decision; apply it; learn only what
the decision genuinely supports.

**Why Phase 1.** `NEEDS_REVIEW` and `NOT_FOUND` are non-terminal states. Without this feature the
loop cannot close and the product's central promise goes unfulfilled.

**Dependencies.** G. (Consumes retrieval's candidates once J/K exist; does not block on them.)

**Complete when.** All five resolution methods work, including `NOT_REQUIRED`. Confidence is
presented as the evidence that produced it, never as a percentage. Previews stream through the
authorized route. Rejecting every candidate returns the requirement to `NOT_FOUND` and records the
rejections so a later run does not re-offer them. Leaving without deciding loses nothing. The
system does not over-generalize from one confirmation.

---

### I. Missing Invoice Report

**Purpose.** The workspace's home for "what do I need to do": run summary, the counting contract,
an action queue of `NOT_FOUND` and `NEEDS_REVIEW`, blocked requirements surfaced separately, and
filters.

**Why Phase 1.** Where the user perceives the product working. Also the entry point to review,
manual upload, and starting another reconciliation.

**Dependencies.** E, H.

**Complete when.** Matched + not found + needs review sum to _documents required_, and
_transactions processed_ is never conflated with it. Counts are computed live from requirement
state; the run supplies coverage, accounts and identity. The queue never becomes a dump of every
transaction. Resolving an item updates the report immediately. Blocked requirements appear as one
connection-level prompt, not row by row.

---

### J. Gmail Connection

**Purpose.** Connect one or more Google accounts to a workspace with incremental consent for
`gmail.readonly`, store credentials encrypted, track connection health, support reauthorization
and disconnect.

**Why Phase 1.** In scope, and retrieval cannot exist without it.

**Dependencies.** A. **External dependency: Google verification / CASA — the paperwork half
starts at feature A, not here; the demo video and the submission cannot start until K exists
(§1).**

**Complete when.** The Gmail scope is requested at connect time and never at sign-up. Tokens are
encrypted at rest, never logged, never returned to the frontend, never sent to a model. Several
accounts per workspace work independently, and the same address in two workspaces is two separate
records. Reconnecting restores the existing connection rather than creating a second. Disconnect
revokes and deletes credentials while **keeping** already-retrieved documents. Connection states are
added to `docs/state-machines.md` in the same change as the table.

---

### K. Gmail Retrieval

**Purpose.** For each requirement, search every connected account over the transaction's date
window, evaluate candidates on their evidence, fetch attachments for selected candidates only, hand
them to document understanding, and advance the requirement to `RESOLVED`, `NEEDS_REVIEW`,
`NOT_FOUND`, `BLOCKED` or `FAILED`.

**Why Phase 1.** The headline automation and the reason the product is not a spreadsheet.

**Dependencies.** F, H, J.

**Complete when.** Gmail access goes through one module; search and evaluation use metadata format
only, and a test asserts the search path issues no full-format request. Message bodies are never
persisted and never sent to a model. Amount is a matching signal, never a search requirement. Auth
failure yields `BLOCKED`, transient failure retries, and neither is confused with `NOT_FOUND`.
Re-running produces no duplicate documents or requirements. Candidates and their evidence are
persisted so review can display them.

---

### L. Excel Export

**Purpose.** A background workflow that builds the complete reconciliation — matched, not found,
needs review, and needing no document — into a stored snapshot the user downloads.

**Why Phase 1.** The artifact that leaves the product and reaches an accountant. Without it the work
stays trapped in the app.

**Dependencies.** I.

**Complete when.** Generation is background work, not a request handler. Every document reference is
a link back into the application, never a storage URL. The file is a snapshot; regenerating produces
a fresh one. Exports are stored with the same privacy rules as source documents.

---

## 8. Feature sequence

```text
A → B → C → D → E → F → G → H → I → J → K → L
```

| Transition | Why                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A → B**  | Storage must check a session and a workspace before streaming bytes; there is no authorization to apply until identity exists                                                                          |
| **B → C**  | Intake's first act is storing the original file; the document must survive before anything is inferred from it                                                                                         |
| **C → D**  | Parsing needs a bound account (for currency), which is C's output. It also settles the period — declared by the document or derived from the transactions (`docs/decisions/0008`)                      |
| **D → E**  | Identification analyses canonical transactions and may assume each movement appears exactly once — a guarantee only D provides                                                                         |
| **E → F**  | Sequenced rather than blocked: F's real dependency is B, but building understanding once requirements exist means it is exercised against transactions it must eventually match                         |
| **F → G**  | Matching needs normalized vendor, amount, date and currency. Those are F's output; without them there is nothing to match on                                                                            |
| **G → H**  | Review resolves `NEEDS_REVIEW`, and G is what first produces that state. Building review earlier means building it against a state nothing creates                                                     |
| **H → I**  | The report's action queue is a list of things to review. Rows leading nowhere are not a shippable report                                                                                                |
| **I → J**  | Deliberate: the loop is proven end-to-end on the manual path before adding an external integration and a restricted scope. Everything downstream of "a document arrived" already exists when retrieval lands |
| **J → K**  | Retrieval needs credentials, connection health, and the `BLOCKED` path. All are J's                                                                                                                    |
| **K → L**  | Export renders the complete reconciliation; running it before retrieval means exporting a state the product does not yet reach                                                                         |

**One thing runs off this line, and only partly.** Google Cloud project setup, OAuth consent
configuration, the verified domain, and the published privacy policy and terms are **started at
A**, in parallel, because they are calendar time we cannot compress later. The **submission
itself cannot be**: it requires a demo video showing the scope's data actually being used, so it
is gated on K rather than on lead time, and the CASA clock starts there (§1). The
`connect-gmail.md §5` OPEN DECISION — Gmail API versus forwarding — must be settled before J is
defined, and it is a product decision, not an implementation detail.

---

## 9. What should NOT be planned yet

Deliberately left open so the decision can be made with evidence, when we reach it:

- **Engineering tickets for any feature.** Each feature gets its own definition session against its
  own workflow document. Planning task 7 of feature K today guarantees re-planning it later.
- **Individual migrations, table columns and indexes.** The schema exists for what is built. The
  four known gaps (Gmail connections, Auth.js tables, match candidates, export artifacts) are named
  in §1 so nobody discovers them mid-task — that is the entire point of naming them, and it is as
  far as it should go.
- **API routes, server action signatures, component trees.** Follow from the feature.
- **Prompts.** Their content, their few-shot examples, and their file layout. Only the rule is
  fixed: versioned files, schema-validated output.
- **OCR and LLM provider selection, and every confidence threshold.** `architecture.md §21` reserves
  these for evaluation. Choosing now means choosing by intuition, which that section exists to
  prevent.
- **Retry policies, backoff, and alerting.** Distinguish recoverable from non-recoverable failure —
  that is a design rule. The numbers come from watching it run.
- **UI polish, empty states, copy, responsive behaviour, animation.** Wireframes and the design
  system carry the intent; the detail belongs to the feature.
- **Testing matrices.** The strategy is settled: unit for pure functions, integration on PGlite,
  golden files for parsing, a handful of end-to-end. Enumerating cases per feature in advance
  produces a document nobody reads.
- **Infrastructure optimization.** Cost, latency, caching, Neon sizing, Inngest concurrency. All are
  deferred by the architecture until real usage says where.
- **Any abstraction for a second invoice source, a second storage provider, or a second LLM.** The
  boundaries are already drawn (one Gmail module, one storage module, one prompt-plus-validation
  shape). That is the correct amount of preparation; a plugin interface for one implementation is
  not.

---

# Phase 1 Definition

### Phase 1 goal

A business owner can go from their real bank statements and their real mailbox to a defensible
reconciliation in which every payment either has a supporting document or an explained, actionable
reason it does not.

### Core product loop

**Statements in → the system understands each payment → it decides which payments owe a document →
it retrieves that document from Gmail or the user supplies it → the user resolves what remains → a
complete reconciliation comes out.** It must re-run over overlapping statements without duplicating
anything, and it must ask fewer questions the second time.

### Phase 1 boundary

**Inside:** identity and workspace; private document storage with authorized serving; statement
intake, identification and account binding; parsing and validation across CSV, text PDF and scanned
PDF, with canonical promotion and coverage; invoice requirement identification with clarification
questions and business knowledge; document classification, extraction and vendor normalization;
manual upload and evidence-based matching; match review with all five resolution methods; Gmail
connection with incremental consent; Gmail retrieval and candidate evaluation; the Missing Invoice
Report; the Excel export.

**Outside:** subscriptions; email notifications; the duplicate merge screen; coverage-gap reporting
UI; the line-by-line discrepancy review tool; vendor and knowledge management screens; sales
invoices; refunds generating requirements; multi-user workspaces; non-Gmail sources;
export-with-documents; push updates; RLS; cost and latency optimization.

### Feature map

A. Identity & Workspace Shell · B. Document Store & Authorized Serving · C. Statement Intake &
Identification · D. Statement Parsing, Validation & Canonical Promotion · E. Invoice Requirement
Identification · F. Document Understanding · G. Manual Upload & Matching · H. Match Review &
Resolution · I. Missing Invoice Report · J. Gmail Connection · K. Gmail Retrieval · L. Excel Export

### Feature sequence

`A → B → C → D → E → F → G → H → I → J → K → L`, with the Google verification paperwork started
as a parallel track at A, the submission and CASA clock starting at K because the demo video
depends on it, and the `connect-gmail.md §5` OPEN DECISION settled before J is defined.

### Development strategy

**Phase → Feature (one vertical slice, one workflow document) → Agent task (one commit).** Each
feature gets its own definition session and is briefed with the glossary, the state machines, its
one workflow document, and the modules it touches — not the repository. Each task ends green:
`tsc --noEmit`, `npm test`, a cross-workspace isolation test wherever workspace-scoped data is
touched, and a pass over `docs/definition-of-done.md`. A state that does not exist is added to
`docs/state-machines.md` in the same change, never invented in code.

### First feature

**A — Identity & Workspace Shell.** ADR 0006 is already written and decides the hard part; the
slice is small, entirely self-contained, and unblocks everything else. It also puts the Google
Cloud project in place, which is what starts the verification clock we cannot compress later.

### Definition of Phase 1 complete

A business owner signs in, creates a workspace, connects their mailbox, and uploads real bank
statements in the formats they actually have. The system parses them correctly or says clearly that
it could not; identifies which payments need supporting documentation and asks only about the ones
it genuinely cannot judge; searches the connected mailboxes and links the documents it is confident
about; presents everything else as a short, honest queue with the evidence for each decision. The
user resolves that queue — by uploading, linking, or saying no document is needed — and downloads an
Excel reconciliation showing every transaction, its status, and a link to its document.

Then they upload three more months, overlapping the first, and nothing duplicates, nothing is asked
twice, and only genuinely new payments appear in the queue.

And the parser has earned the streak in `docs/parsing-acceptance.md` — six consecutive unseen
statements read correctly on first attempt. Phase 1 is not complete on a parser that has only
ever been right about documents it was repaired against.

And document understanding has earned the streak in `docs/extraction-acceptance.md`, on the
same terms and for the same reason. A reconciliation is only as good as the amounts on the
documents it matched.
