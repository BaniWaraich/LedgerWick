# 0001 — Spec reconciliation: entities, states, and vocabulary

Status: Accepted · 2026-09-07

## Context

The seven specification documents in `docs/` were written before implementation, the
domain model first and the workflows afterwards. The workflows introduced concepts the
domain model did not have (invoice requirements with state and history, reconciliation
runs, statement coverage, business knowledge) and each restated its own vocabulary for
overlapping states.

A review before starting implementation found the specs coherent in principle but carrying
several conflicts that would have become schema decisions made by accident. Three were
blocking: no owner for transaction deduplication across overlapping statements, no rule
binding a statement to a bank account, and one concept ("expected invoice" / "invoice
requirement") described as derived in one document and durable in another.

## Options

1. Start implementing and let the code settle the questions. Rejected: the questions are
   schema-shaped, and a schema settled by accident is expensive to unsettle.
2. Rewrite the specification set from scratch. Rejected: the existing documents are good
   and the conflicts are localized.
3. Targeted reconciliation — add a glossary and a state reference, promote the missing
   entities into the domain model, write the two workflows referenced but never written,
   and fix the conflicts in place. Chosen.

## Decision

### Vocabulary and state

`docs/glossary.md` is the single source for concept names; `docs/state-machines.md` for
state names and transitions. Workflow documents describe _when_ transitions happen and
reference these for _what the states are_.

### Statement Line vs Canonical Transaction

A Statement Line is an immutable row from one statement. A Canonical Transaction is the
business's single record of a financial movement. Deduplication happens exactly once,
promoting lines to canonical transactions at upload; every later workflow may assume it.

The V1 identity rule is bank account + value date + signed amount + normalized description

- occurrence index, superseded by a bank-supplied reference where one exists. Deliberately
  strict: a missed duplicate is a visible extra row, a false merge silently destroys a real
  payment.

### Invoice Requirement is a persisted entity

Not derived. Work is performed against it, users act on it, and both must survive. At most
one per canonical transaction. "Expected Invoice" is retired.

### Supporting Document vs Invoice

Every file is a Supporting Document. An Invoice is a Supporting Document classified and
extracted as one. A payment confirmation may resolve a requirement without becoming an
Invoice — which keeps the one-to-one Invoice ↔ Transaction invariant constraining extracted
invoices rather than arbitrary evidence. Retrieval no longer bypasses classification.

### Statement–account binding

Every statement binds to exactly one bank account in the uploading user's workspace, by
account identifier, creating the account if absent and asking the user if the document
does not say. The lookup never crosses a workspace boundary — this is a security rule, not
a matching convenience.

### Supabase Postgres, application-layer isolation

**Superseded in part by 0005.** The hosting and authentication choices below were not the
result of a comparison and have been replaced by Neon and Auth.js. The isolation decision
stands, and is the reason that replacement was cheap.

The database is the Supabase-hosted Postgres instance, and workspace isolation is enforced
in the application layer rather than by row-level security, because the frontend has no
direct database access. Authentication is Supabase Auth.

### Export links

The Excel export contains links back into the application, never storage URLs. Export is a
background workflow producing a snapshot.

### Human-in-the-loop

Short bounded waits use Inngest wait-for-event. Open-ended waits — anything a person might
answer days later — are persisted domain state, never a suspended workflow.

### Product naming

"Muneem Ji" is the internal project name and is used in these documents. "Ledgerwick" is
the official product name and is used in everything a customer sees.

## Consequences

- The first migration follows the domain model as now written; the entities above are
  tables, not derived views.
- The two 1:1 invariants become database constraints, per `docs/architecture.md §2.6`.
- Application-layer isolation obliges a data access layer that requires a workspace, and
  tests that attempt cross-workspace access and expect failure.
- One question remains open: whether to reach mail through the Gmail API at all, given that
  CASA is a fixed cost of doing so (`docs/workflows/connect-gmail.md §5`). It must be
  settled before launch and does not block development.
- Two former open questions are now settled with revisit triggers recorded in place —
  exchange rates are for match scoring only (`docs/domain-model.md §11.1`), and the Excel
  export links back into the application rather than bundling files
  (`docs/workflows/missing-invoice-report.md §9`).
