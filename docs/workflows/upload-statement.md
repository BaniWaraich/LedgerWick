# Upload Bank Statement

## 1. Actor

**Business Owner**

---

## 2. Goal

Allow a business owner to upload one or more bank statements and have Muneem Ji extract and validate the underlying transactions.

The system should process each uploaded statement independently and clearly communicate whether the statement was successfully processed, contains a discrepancy, or could not be processed.

---

## 3. Inputs

### Supported file formats

- PDF
- CSV
- Excel

### Multiple files

The user may upload multiple files simultaneously.

Each file should be processed independently. A failure in one file should not prevent other valid files in the same upload batch from being processed.

Example:

```text
Statement A → Completed
Statement B → Completed
Statement C → Discrepancy
Statement D → Failed
```

---

## 4. Trigger

The workflow begins when the user clicks **"Upload Statement"** and selects one or more files.

---

## 5. Workflow

### Step 1 — Select files

The user selects one or more files to upload.

### Step 2 — Upload

The system uploads the selected files.

### Step 3 — Identify

The system determines whether each uploaded file is a bank statement.

If it is a bank statement, the system identifies:

- Bank
- Account identifier (account number, masked account number, or IBAN as printed)
- Account type, where available (e.g. savings/current)
- Statement period — the date range the statement covers
- Relevant statement information required for parsing

The statement period is required. A statement whose period cannot be determined cannot be
used for coverage tracking and must be treated as `FAILED` rather than silently accepted.

### Step 3a — Bind to a Bank Account

Every statement must belong to exactly one Bank Account within the uploading user's
Workspace before its transactions may be persisted.

The system resolves the account identified in Step 3 against the Workspace's existing
Bank Accounts:

```text
Identified account
        │
        ├── matches one account in this Workspace  → bind to it
        │
        ├── matches no account in this Workspace   → create it, then bind
        │
        └── cannot be identified from the document → ask the user to choose or create
```

Matching is performed on the account identifier, scoped to the Workspace and the bank.
Where a statement shows only a masked account number, the visible digits combined with the
bank are sufficient for V1; the user confirms on first creation.

Two rules are absolute:

- **The search for a matching account never leaves the uploading user's Workspace.** An
  account identifier appearing in another Workspace is not a match and must not be
  reported to the user in any form. Workspace isolation is a security boundary, not a
  convenience — see `docs/architecture.md §19`.
- **A statement is never bound to an account by inference alone when the identifier is
  absent.** If the document does not state which account it covers, the user chooses.

The bound account determines the currency in which the statement's amounts are
interpreted.

### Step 4 — Parse

The system extracts the transactions and relevant balance information from the statement.

The implementation may use different parsing strategies depending on the file and statement format.

The parsing implementation is intentionally not fixed by this workflow.

### Step 5 — Validate

The system validates the extracted data.

Validation includes:

- Confirming transactions were extracted.
- Confirming an opening balance is available.
- Confirming a closing balance is available.
- Performing row-by-row transaction validation where possible.
- Verifying the statement's balance reconciliation.

The primary reconciliation rule is:

```text
Opening Balance + Credits - Debits = Closing Balance
```

### Step 5a — Promote to canonical transactions

Validation operates on Statement Lines: the rows exactly as extracted from this one file.

Before those lines are visible to any later workflow, they are promoted to Canonical
Transactions, which is where deduplication happens — once, here, and nowhere else.

For each Statement Line, the system looks for an existing Canonical Transaction on the same
Bank Account that describes the same financial movement.

The V1 identity rule is:

```text
Same Bank Account
  AND same value date
  AND same signed amount
  AND same normalized description
  AND same occurrence index within that (date, amount, description) group
```

- **Normalized description** means the raw description with case, runs of whitespace, and
  punctuation normalized. It is deliberately conservative: descriptions are normalized for
  formatting only, never interpreted.
- **Occurrence index** exists because a business may legitimately make two identical
  payments on the same day. Two identical lines in one statement are two transactions; two
  identical lines in _overlapping_ statements covering the same date are one.
- Where the bank supplies a stable reference or UTR, it takes priority over the composite
  rule above and is used alone.

Matching lines link to the existing Canonical Transaction. Non-matching lines create a new
one.

```text
Statement A (Apr 1 – May 9)  ──► line: May 5, ₹4,850, ACME ──┐
                                                             ├──► one Canonical Transaction
Statement B (May 1 – Jun 1)  ──► line: May 5, ₹4,850, ACME ──┘
```

Re-uploading a statement that has already been processed therefore produces no new
Canonical Transactions, which is what makes the whole pipeline safe to re-run.

The Statement Line is retained regardless. It is the evidence of what each statement
actually said, and it keeps every Canonical Transaction traceable back to the documents it
came from.

This rule is deliberately strict. A missed duplicate is visible to the user as a repeated
row; a false merge silently destroys a real payment. Where the rule is uncertain, it
should create two transactions rather than merge.

### Step 5b — Record coverage

On successful validation, the statement's period is recorded as Statement Coverage for the
bound Bank Account.

Coverage is what later allows the system to tell the user which periods are still missing,
and to tell a reconciliation run which transactions it has already seen.

### Step 6 — Present result

The system presents a concise processing summary to the user.

The user should not be required to manually verify every successfully extracted transaction as part of the normal flow.

Detailed transaction information may be available when the system detects a discrepancy or when the user explicitly chooses to review it.

---

# 6. Processing States

Each uploaded statement has its own processing state.

The states and their user-facing messages are defined in `docs/state-machines.md §1`.

In summary: a statement moves `UPLOADING → IDENTIFYING → PARSING → VALIDATING →
COMPLETED`, and may reach `FAILED` from any of those.

`VALID` and `DISCREPANCY` are **not states**. They are the validation outcome of a
statement that reached `COMPLETED`. A statement with a discrepancy was processed
successfully; the system simply does not trust the numbers.

The progress UI should communicate genuine processing stages rather than implying an exact percentage when exact progress cannot be determined.

---

# 7. Successful Result

A statement is considered successfully processed and **VALID** when:

- Transactions have been extracted.
- Opening balance is known.
- Closing balance is known.
- The transaction sequence reconciles.
- The following equation is satisfied:

```text
Opening Balance + Credits - Debits = Closing Balance
```

The user should see a concise parsing summary containing information such as:

```text
Statement processed ✓

HDFC Bank
Current Account

1,248 transactions extracted

Opening balance    ₹120,000
Closing balance    ₹187,450

✓ Transactions reconciled

[Continue]
```

The exact visual presentation is defined by the corresponding wireframe.

---

# 8. Discrepancy

A statement enters the **DISCREPANCY** validation outcome when the extracted transactions do not reconcile with the statement's balances.

A discrepancy may indicate:

- Transactions were missed during extraction.
- Transactions were incorrectly extracted.
- The statement format was incorrectly interpreted.
- Other information required for reconciliation could not be reliably extracted.

A discrepancy does **not** necessarily mean that processing failed.

The system successfully processed the document but does not have sufficient confidence in the extracted result.

The user should be informed that attention is required and should be given an option to review the discrepancy.

Example:

```text
Attention needed

HDFC Bank
1,248 transactions extracted

The transactions could not be fully reconciled.

Difference: ₹2,500

This may mean that a transaction was missed
during extraction.

[Review]
```

---

# 9. Failure

A statement enters the **FAILED** state when the system cannot reliably process it.

Possible failure reasons include:

- Unsupported file format.
- Document is not a bank statement.
- Statement is unreadable.
- Statement is too long or exceeds processing limits.
- Statement extraction failed.
- An internal system error occurred.

The system should provide the user with a human-readable explanation of the failure rather than a generic technical error wherever possible.

Example:

```text
We couldn't process this statement.

The document appears to be a scanned copy
and the text could not be read clearly.

Please upload a clearer copy.

[Try again]
```

The exact failure UI will be designed separately.

---

# 10. Processing Output

For each uploaded statement, the system should produce or retain:

- Processing status
- Processing failure reason, if applicable
- Bank
- Account type, where available
- Number of transactions extracted
- Opening balance
- Closing balance
- Total credits
- Total debits
- Validation outcome
- Discrepancy information, where applicable
- Extracted transactions

The exact data representation is an implementation concern and is not defined by this workflow.

---

# 11. Multiple-File Processing

Multiple files are treated as a single upload batch but are processed independently.

The system should allow different files within the same batch to reach different outcomes.

Example:

```text
Upload Batch

├── HDFC January.pdf
│   └── COMPLETED / VALID
│
├── HDFC February.pdf
│   └── COMPLETED / VALID
│
├── SBI March.pdf
│   └── COMPLETED / DISCREPANCY
│
└── document.pdf
    └── FAILED
```

The user should be able to understand the outcome of each file.

---

# 12. What Happens Next?

When a statement has been successfully processed and validated, Muneem Ji presents the parsing summary.

The next workflow begins after successful statement processing:

```text
Validated transactions
        ↓
Invoice identification
        ↓
Transaction analysis
        ↓
Identify invoices that may be required
        ↓
Search / retrieve relevant invoices
        ↓
Ask user questions when additional context is required
```

This is a separate workflow and is intentionally not included in the Upload Bank Statement workflow.

Muneem Ji may learn information provided by the user during subsequent workflows, such as:

- Known vendors
- Known subscriptions
- Transaction context
- Other business-specific knowledge

This information may be used to reduce unnecessary questions in future interactions.

If user input is required while the user is away from the application, the system should be able to notify the user that questions are waiting for them.

Notification behavior will be defined as part of the subsequent workflow.

---

# 13. Implementation Boundary

This workflow defines **what the system must accomplish**, not how it must accomplish it.

The implementation may use:

- Deterministic parsers
- OCR
- LLMs
- Specialized bank-specific parsing logic
- Other processing techniques

The specific implementation should remain replaceable.

The system should expose a consistent processing outcome regardless of which parsing strategy is used internally.

The initial implementation should prioritize:

1. Correctness
2. Reliability
3. Ability to handle real-world statements
4. Clear failure handling
5. Testability

Cost optimization and extensive parser optimization are intentionally deferred until real usage provides evidence about where optimization is necessary.
