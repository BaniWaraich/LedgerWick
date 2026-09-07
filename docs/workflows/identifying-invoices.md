# Identify Invoice Requirements

## 1. Actor

**Business Owner**

The system performs the analysis automatically. The business owner may be asked questions when the system needs additional context about a transaction.

---

## 2. Goal

Analyze successfully parsed bank transactions at the **business level** and identify transactions for which supporting invoices are likely required for accounting reconciliation.

The system should:

- Evaluate transactions across all relevant uploaded bank statements.
- Identify payments that may require supporting invoices.
- Recognize known vendors, subscriptions, and transaction patterns.
- Ask the user for clarification when the system cannot confidently determine the nature of a transaction.
- Learn relevant business-specific information from the user's answers.
- Produce a human-readable list of invoice requirements.

---

## 3. Inputs

The workflow receives successfully parsed and validated transactions from one or more bank statements.

Each transaction should retain its relationship to its source statement and bank account, including the relevant statement period.

The analysis therefore operates across:

```text
Business
    ↓
Multiple Bank Accounts
    ↓
Multiple Bank Statements
    ↓
Transactions
```

The system must retain enough source information to determine:

- Which bank account the transaction came from.
- Which bank statement contained the transaction.
- The statement's covered date range.
- The transaction date.

This information is required for later reconciliation and coverage checks.

---

## 4. Trigger

The workflow begins automatically after the relevant uploaded bank statements have been successfully parsed and validated.

The user does not need to manually start the analysis.

---

## 5. Workflow

### Step 1 — Collect relevant transactions

The system collects the **Canonical Transactions** produced by statement upload
(`docs/workflows/upload-statement.md`, Step 5a), across every Bank Account in the Workspace.

Deduplication across overlapping statements has already happened at that point. This
workflow never sees Statement Lines and never deduplicates.

Transactions already carrying an Invoice Requirement from a previous run are skipped; the
run analyzes what is new.

Transactions are analyzed at the **business level**, rather than independently for each bank statement.

### Step 2 — Evaluate transactions

The system analyzes each transaction to determine whether it may require a supporting invoice.

The analysis may consider:

- Transaction description.
- Amount.
- Date.
- Vendor/payee.
- Recurrence.
- Existing business knowledge.
- Known vendors.
- Known subscriptions.
- Previous user answers.
- Account context.
- Other relevant transaction information.

### Step 3 — Identify transaction context

The system attempts to determine what each relevant transaction represents.

Examples:

```text
ANTHROPIC → likely software subscription

CLAUDE → likely same vendor/service as Anthropic

BLINKIT → likely grocery purchase

TRANSFER TO OWN HDFC ACCOUNT → internal transfer

PAYMENT TO FRIEND → likely personal payment
```

The system should be capable of recognizing equivalent names for the same vendor or service where possible.

For example:

```text
Anthropic
Claude
Anthropic*Claude
```

may represent the same underlying vendor/service.

### Step 4 — Use existing business knowledge

Before asking the user a question, the system should check existing business-level knowledge.

Examples:

```text
Known Vendor:
Anthropic

Known Subscription:
Claude

Known Transaction:
Monthly payment to Anthropic = business software expense
```

Previously established knowledge should reduce unnecessary questions in future analyses.

### Step 5 — Ask for clarification when necessary

If the system cannot confidently determine the context of a transaction, it may ask the business owner.

Example:

```text
We found a payment of ₹4,850 to XYZ Services.

Is XYZ Services:

○ A business vendor
○ A personal payment
○ Something else
```

A Clarification Question is **persisted** (`docs/domain-model.md §3.15`). The user may be
away when it is raised and must be able to answer later; the analysis does not stall
waiting for them, and does not discard the question if they never return during that run.

The user's answer becomes Business Knowledge where it generalizes beyond the transaction
that prompted it.

The system should not repeatedly ask the same question when the answer is already known.
Asking twice is worse than not asking: it tells the user their answers go nowhere.

### Step 6 — Determine invoice requirement

Using the transaction context and business knowledge, the system determines whether a supporting invoice is likely required.

The objective is not to classify transactions according to arbitrary merchant categories.

The objective is to determine:

> **Which payments require supporting documentation for the business's accounting and reconciliation process?**

Generally, business-related expenses should be considered candidates for invoice collection.

Examples may include:

- Business software subscriptions.
- Vendor payments.
- Professional services.
- Business purchases.
- Client meals or other business expenses.
- Significant business expenses.
- Other payments for which supporting documentation may be required for accounting purposes.

Some transactions generally do not require an invoice, such as:

- Transfers between the business's own bank accounts.
- Certain bank or payment-processing fees.
- Other transactions that do not represent an expense requiring supporting documentation.

The precise treatment of edge cases may evolve as the product is tested with real businesses.

### Step 7 — Produce Invoice Requirements

The system produces a human-readable list of transactions for which invoices should be collected.

Example:

```text
Invoices needed

1. Anthropic / Claude
   ₹4,850
   15 April
   Software subscription

2. XYZ Services
   ₹18,500
   21 April
   Vendor payment

3. Client lunch — ABC Restaurant
   ₹3,200
   25 April
   Business expense
```

Each Invoice Requirement is persisted against its Canonical Transaction, at most one per
transaction (`docs/domain-model.md §3.12`), in the `IDENTIFIED` state.

---

# 6. Processing States

The workflow should expose meaningful processing states.

This analysis is a stage of a **Reconciliation Run** (`docs/state-machines.md §4`) and does
not have a persisted state model of its own. Its output is Invoice Requirements, each
created in the `IDENTIFIED` state.

Progress is reported to the user as a stage within the run:

| Stage              | User-facing message                                |
| ------------------ | -------------------------------------------------- |
| Evaluating         | Evaluating your transactions…                      |
| Identifying        | Identifying payments that may need invoices…       |
| Checking knowledge | Checking what we already know about your business… |
| Awaiting answers   | We need your help with a few transactions…         |
| Complete           | We've identified the documents you may need.       |

Awaiting answers is not a blocking stage: the run continues with the transactions it can
determine, and outstanding Clarification Questions are resolved independently (section 7).

The UI should communicate actual processing stages rather than displaying an artificial percentage that implies precise progress.

---

# 7. User Questions

Questions should only be presented when additional information is required to make a useful determination.

Questions should be:

- Specific.
- Human-readable.
- Related to an actual transaction.
- Answerable without technical knowledge.

The system should use existing business knowledge before asking questions.

When the user provides an answer that is useful beyond the current transaction, the information should be stored as business-level knowledge where appropriate.

Examples:

```text
"Anthropic is our software vendor."

"Claude and Anthropic are the same vendor."

"XYZ Services is our accountant."

"Payments to this account are internal transfers."
```

This knowledge can be used in future analyses.

---

# 8. Multiple Bank Statements

Invoice identification operates across all relevant statements belonging to the business.

For example:

```text
Business
│
├── HDFC
│   └── March 1 – April 30
│       └── Transactions
│
└── SBI
    └── March 15 – April 30
        └── Transactions
```

The system should perform a unified analysis across these transactions.

However, source information must be preserved.

Every transaction should remain traceable to:

```text
Business
    ↓
Bank Account
    ↓
Bank Statement
    ↓
Transaction
```

This is necessary because reconciliation occurs over specific accounting periods and because the system must detect missing statement coverage.

---

# 9. Statement Coverage and Overlapping Statements

The system must track the date range covered by each uploaded bank statement.

This allows Muneem Ji to identify gaps in statement coverage.

Example:

```text
HDFC

March 1 – April 30 ✓
May 1 – May 31   ✗
```

The system should be able to identify that May has not yet been covered.

The system must also handle overlapping statements.

Example:

```text
Statement A:
April 1 – May 9

Statement B:
May 1 – June 1
```

Transactions appearing in both statements should not be treated as two separate transactions during reconciliation.

Overlap is resolved before this workflow runs, by the canonical transaction rule in
`docs/workflows/upload-statement.md`, Step 5a. This workflow operates on Canonical
Transactions and may assume each financial movement appears exactly once.

Coverage gaps remain this workflow's concern: it reads Statement Coverage
(`docs/domain-model.md §3.4`) to report periods the business has not yet provided.

---

# 10. Zero Invoice Requirements

If the analysis identifies no transactions requiring supporting invoices, the system should communicate this clearly.

Example:

```text
We couldn't find any transactions that appear
to need invoices.

You can still upload invoices you already have
and we'll help reconcile them.

[Upload invoices]
```

Zero identified invoice requirements is a valid outcome and is not considered a system failure.

---

# 11. Failure and Retry

If analysis fails, Muneem Ji should determine whether the failure is potentially recoverable.

### Recoverable failures

Examples:

- Temporary LLM/API failure.
- Network timeout.
- Temporary service unavailability.

The system should retry automatically according to an appropriate retry policy.

### Non-recoverable / internal failures

Examples:

- Required API credits are unavailable.
- Configuration is invalid.
- A required service is unavailable for an extended period.
- An unexpected internal system error occurs.

The system should not retry indefinitely.

The user should receive a friendly message explaining that there is an issue on Muneem Ji's side.

Example:

```text
We ran into an issue while analyzing your transactions.

Your statements are safe, but we weren't able
to complete this step.

We're looking into it. Please try again later.
```

Internal monitoring/alerting should notify the appropriate administrator when an issue requires intervention.

The exact retry policy and monitoring implementation are outside the scope of this workflow.

---

# 12. Successful Result

The workflow is successful when Muneem Ji has:

- Evaluated the relevant transactions.
- Determined the context of transactions where possible.
- Used existing business knowledge where available.
- Obtained user clarification where necessary.
- Identified transactions that may require invoices.
- Produced a human-readable list of invoice requirements.
- Preserved the relationship between each invoice requirement and its underlying transaction.

The next workflow can then begin:

```text
Invoice Requirements
        ↓
Find / Retrieve Invoices
        ↓
Match Invoices to Transactions
```

---

# 13. Output

For each identified invoice requirement, the system should retain or produce:

- Underlying transaction.
- Transaction date.
- Transaction amount.
- Transaction description.
- Vendor/payee, where identifiable.
- Business context / classification.
- Reason an invoice may be required.
- Source bank account.
- Source bank statement.
- Statement coverage period.
- Invoice requirement status.

The exact data representation is an implementation concern.

---

# 14. Implementation Boundary

This workflow defines the desired product behavior, not the specific technology used to achieve it.

The analysis may use:

- LLMs.
- Deterministic rules.
- Business-level memory.
- Vendor matching.
- Subscription recognition.
- Other classification or reasoning mechanisms.

The implementation should be replaceable without changing the user-facing workflow.

The initial implementation should prioritize:

1. Correctness.
2. Useful transaction understanding.
3. Reliable handling of user context.
4. Avoiding unnecessary questions.
5. Traceability from invoice requirement → transaction → bank statement.
6. Testability.

Optimization of model cost, inference strategy, and classification architecture can be addressed after real usage provides evidence about where optimization is necessary.
