# Missing Invoice Report

## 1. Actor

**Business Owner**

The system has already done the reconciliation work. The business owner comes here to
understand what remains and to resolve it.

---

## 2. Goal

Show the user only the items that need their attention, with enough context to understand
the state of the latest Reconciliation Run.

The page should let the user:

- understand how much of the reconciliation is complete,
- see which requirements found no document,
- see which need review,
- resolve those items,
- start a new reconciliation by uploading more statements,
- download the complete reconciliation as an Excel report.

---

## 3. Inputs

The report is a view over persisted state. It computes nothing of its own.

### Reconciliation Run

- Run ID
- Run date
- Statement Coverage examined
- Bank accounts included
- Canonical Transactions processed

### Invoice Requirements

For each: the Canonical Transaction, its date, amount, vendor/expense name, the reason a
document is required, the requirement state, the resolving document where one exists, and
the resolution method.

The action queue shows requirements in `NOT_FOUND` and `NEEDS_REVIEW`
(`docs/state-machines.md §2`). Resolved requirements and transactions needing no document
are not shown in it.

---

## 4. Trigger

Available once a Reconciliation Run has produced results, and viewable at any time from the
Workspace.

The page is a snapshot of current state, not a process that continues searching.

---

## 5. Summary

The summary orients; it does not act.

```text
147 transactions processed
  38 needed a document
  13 matched
  18 not found
   7 need review

Last run: 7 August 2026 · RUN-20260807-001
Coverage: 1 March → 31 July · HDFC, SBI
```

### The counting contract

Two denominators exist and they must never be conflated:

- **Transactions processed** — every Canonical Transaction in the run's coverage. The
  context line.
- **Documents required** — the Invoice Requirements created from those transactions. This
  is the denominator for matched / not found / needs review, and the three must sum to it.

Anywhere the product says "12 expected, 9 found, 3 missing", _expected_ means Invoice
Requirements, never transactions. A transaction that needs no document is not missing
anything.

If the run's coverage has gaps, say so here. A report that looks complete while three
months are unexamined is actively misleading.

---

## 6. Action queue

The primary table contains only requirements needing the user.

### Not found

The system determined a document was needed and could not find one in the connected Gmail
accounts.

Show what was searched — which accounts, over what window — so that "not found" is an
informative answer rather than a shrug. The user can then upload the document, link an
existing one, or say none is needed.

### Needs review

The system found something plausible but could not decide.

Both lead into `invoice-match-review.md`.

### Blocked

Requirements in `BLOCKED` are shown separately, above the queue, because they are not the
user's decision to make row by row — they are one broken Gmail connection standing between
the user and a batch of results.

```text
7 invoices are waiting on founder@gmail.com
[Reconnect]
```

---

## 7. Filtering

At minimum: All / Not found / Needs review.

The table must never become a dump of every transaction. A matched transaction needs no
attention and does not belong here.

---

## 8. Starting a new reconciliation

A **Start new reconciliation** action returns the user to statement upload.

Starting again does not mean starting from zero. The Workspace retains previous Runs,
Canonical Transactions, Statement Coverage, bank accounts, Business Knowledge, and every
resolved requirement.

```text
Previously reconciled: March → June
New upload:            January → August
        ↓
Existing transactions recognized by the canonical transaction rule
        ↓
Only new transactions produce new requirements
        ↓
New Reconciliation Run
```

Deduplication is settled at statement upload
(`docs/workflows/upload-statement.md`, Step 5a). This page consumes the result.

---

## 9. Excel export

The user can download the complete reconciliation, not merely the unresolved rows:
matched, not found, needs review, and transactions needing no document.

The export reflects the state at the moment it is generated. Resolving an item and
re-downloading produces an updated file.

### Document references in the export

A spreadsheet is opened outside the application, where the user has no session. This
creates a genuine tension with `docs/architecture.md §19`, which forbids exposing storage
URLs.

The export therefore contains, per row, a **link back into Muneem Ji** — a URL to that
document's page in the application — and never a direct storage URL.

Following it requires signing in, which is correct: the link is a pointer to the document,
not the document itself. Anyone the spreadsheet is forwarded to sees the reconciliation
data it contains, but cannot pull the underlying files without access to the Workspace.

**Deferred, not forgotten.** Accountants may well want the files themselves rather than
links to them, and following a link means signing in.

This is a UX annoyance, not a correctness or architecture problem, and the alternative is
not being built until someone confirms they need it.

**Revisit if users report that signing in to retrieve each document is a real obstacle.**
The answer then is a separate "export with documents" action producing a zip of the
spreadsheet plus the files — a deliberate, user-initiated act of taking the data out of the
product, which is why it is a distinct action rather than a change to this one.

Recorded so that it is not re-argued from scratch: the current behaviour is a decision, not
an oversight.

Generating the export is background work
(`docs/architecture.md §7`): a large workspace's export is not an HTTP request.

---

## 10. Relationship to the previous workflows

The Missing Invoice Report does not retrieve documents, does not decide whether a document
is required, and does not search Gmail. That has already happened.

```text
Previous workflows
       ↓
Invoice Requirement state
       ↓
Missing Invoice Report
       ↓
"What do I need to do?"
```
