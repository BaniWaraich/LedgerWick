# 0015 — Read mail through the Gmail API, and pay for CASA

Status: Accepted · 2026-09-25 · Closes the OPEN DECISION in `docs/workflows/connect-gmail.md §5`

## Context

`connect-gmail.md §5` left open whether to reach a customer's mail through the Gmail API at
all. `docs/phases/phase-1.md §8` requires the question settled before feature J is defined,
because it is a product decision and J cannot be specified around both answers.

The cost that makes it a question: `gmail.readonly` is a **Restricted** scope, and so is
`gmail.metadata`. Either one obliges Google's CASA security assessment before the app may be
used by people outside a test list — a third-party audit with real cost and weeks of lead
time, and one that cannot begin until the product can be filmed using the scope
(`phase-1.md §1`).

## Options

**A — Gmail API with OAuth.** The user grants `gmail.readonly` through Google's consent
screen and the system searches the mailbox. Reads mail that already exists. Pays CASA.

**B — auto-forwarding to an address we control.** The user sets a Gmail filter that forwards
invoice-like mail to a per-workspace address; we ingest it. No OAuth, no Restricted scope, no
CASA.

## Decision

**Option A.** The Gmail API with OAuth, accepting CASA as a fixed cost of the product.

Option B remains possible later as an *addition*, for users who refuse OAuth. It is not a
replacement.

## Why

Forwarding is **prospective**. It sees mail that arrives after the filter exists and nothing
before it. The product's primary flow is retroactive by definition: a business uploads past
statements and asks for the documents behind them. Option B cannot serve that flow at all,
only the steady state after it.

B also changes what the system is. Holding a mailbox rather than reading one swaps the
assessment for an inbound-mail security burden of our own — spoofed senders, unsolicited
mail, retention of content nobody reviewed — and adds a setup step the user performs inside
Gmail and can silently break.

What is traded away: the CASA cost and its lead time, which sits at the end of Phase 1 rather
than alongside it (`phase-1.md §1`). No external user can use retrieval until it clears.
Development is unaffected; it proceeds against a test account under an unverified app.

## Consequences

- `connect-gmail.md §5` loses its OPEN DECISION marker and points here.
- Feature J requests `gmail.readonly` incrementally, at connect time, and never at sign-in
  (`0006`). Feature K confines itself to metadata for search, as `§5` already requires.
- The Google verification track (the demo video, the submission, the assessment) proceeds as
  planned once K can be filmed.
