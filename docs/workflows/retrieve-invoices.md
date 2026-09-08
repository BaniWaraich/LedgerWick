# Retrieve Supporting Documents

## 1. Actor

**System**

This workflow runs automatically after invoice requirements have been identified.

The business owner does not need to manually initiate the retrieval process.

---

## 2. Goal

For each identified invoice requirement, search the business's connected Gmail accounts and retrieve the supporting document associated with the underlying transaction.

The system should:

- Search all Gmail accounts connected to the business.
- Use transaction and vendor information to find relevant emails.
- Identify potential supporting documents.
- Retrieve supporting documents where available.
- Automatically associate a high-confidence document with its invoice requirement.
- Ask the user for help when the system cannot confidently determine the correct document.
- Report invoice requirements for which no suitable document was found.

---

## 3. Inputs

The workflow receives a list of **invoice requirements** from the Identify Invoice Requirements workflow.

Each invoice requirement is associated with a specific transaction.

At minimum, the requirement should provide:

- Transaction ID
- Transaction date
- Transaction amount
- Currency
- Transaction description
- Human-readable vendor / expense name
- Machine-readable vendor / expense identity
- Known vendor aliases, where available (both confirmed and inferred — see section 6.1)
- Business context / expense context
- Source bank account
- Source bank statement
- Statement period

A conceptual representation might look like:

```json
{
  "transaction_id": "txn_123",
  "transaction_date": "2026-04-14",
  "amount": 20,
  "currency": "USD",
  "vendor": {
    "name": "Anthropic",
    "aliases": ["Claude", "Claude AI", "Anthropic Claude"]
  },
  "description": "CLAUDE.AI SUBSCRIPTION",
  "expense_context": "Business software subscription"
}
```

The exact data structure is an implementation concern and is not locked by this workflow.

---

# 4. Trigger

The workflow begins automatically after the Identify Invoice Requirements workflow completes.

Conceptually:

```text
Statement processing
       ↓
Transaction analysis
       ↓
Invoice requirements
       ↓
Retrieve supporting documents
```

The system should process requirements without requiring the user to remain on the application.

---

# 5. Gmail Accounts

A business may connect multiple Gmail accounts.

The retrieval system should search across **all Gmail accounts explicitly connected to the business**.

Example:

```text
Business
│
├── accounts@company.com
├── founder@gmail.com
└── finance@company.com
```

Gmail authorization and account connection are handled by the separate **Connect Gmail** workflow.

---

# 6. Retrieval Strategy

For each invoice requirement, Muneem Ji searches Gmail using information associated with the specific transaction.

Potential search signals include:

- Vendor name
- Vendor aliases
- Transaction description
- Transaction date
- Approximate date range
- Invoice-related keywords
- Receipt-related keywords
- Other known information about the vendor or expense

The system should search for supporting documentation associated with the **specific transaction**, rather than performing a generic search for invoices.

## 6.1 Confirmed and inferred aliases

A **confirmed** Vendor Alias is authoritative Business Knowledge; the user established it.

An **inferred** alias is a model suggestion — for example, that `CLAUDE` and `ANTHROPIC`
denote the same vendor.

Inferred aliases **may** be used to widen a Gmail search. Searching more broadly costs
little and every candidate is evaluated on its own evidence afterwards.

Inferred aliases **may not** be persisted as Business Knowledge, and may not on their own
raise a candidate to the confidence required for automatic association. Persisting requires
user confirmation — see `docs/architecture.md §11`.

---

# 7. Date Range

The initial search window should cover approximately:

**7 days before through 7 days after the transaction date.**

This allows for situations where:

- An invoice is issued before payment.
- An invoice is emailed after payment.
- A small business sends an invoice several days later.
- Email and bank transaction dates differ.

The date window may be adjusted later based on real-world usage.

---

# 8. Amount Matching

Transaction amount should **not be used as a strict Gmail search requirement**.

Amounts may differ because of:

- Currency conversion.
- Exchange rates.
- Taxes.
- Fees.
- Rounding.
- Different amounts appearing on invoices and bank statements.

Amount may still be used as a matching signal when evaluating retrieved documents.

For example:

```text
Bank transaction:
$20

Retrieved document:
₹1,700
```

The difference in amount should not automatically disqualify the document if other evidence strongly suggests that it corresponds to the transaction.

---

# 9. Candidate Email Retrieval

The system searches connected Gmail accounts for emails that may correspond to the invoice requirement.

Candidate emails may be evaluated using:

- Sender
- Recipient
- Subject
- Email date
- Email body
- Attachments
- Attachment filenames
- Other relevant metadata

The system should identify whether an email appears to contain or reference a supporting document.

Examples:

```text
Your Anthropic invoice
Your Claude receipt
Payment confirmation
Invoice #INV-92831.pdf
Receipt.pdf
```

---

# 10. Supporting Documents

A supporting document is documentation that may provide evidence of a business transaction for accounting or reconciliation purposes.

Possible document types include:

- Invoice
- Receipt
- Payment receipt
- Payment confirmation
- Other relevant proof of purchase or payment

A receipt or payment confirmation may therefore be treated as a valid supporting-document candidate.

Muneem Ji should not assume that only documents explicitly labelled "invoice" are useful.

Whether a particular document is sufficient for a specific tax or accounting purpose depends on the business, jurisdiction, and accounting requirements. Muneem Ji should not make universal legal or tax claims about document sufficiency.

---

# 11. Document Retrieval

When a candidate supporting document is identified, Muneem Ji should retrieve the actual document where possible.

The initial implementation should primarily support document attachments such as PDFs.

Example:

```text
Gmail
  ↓
Candidate email
  ↓
PDF attachment
  ↓
Retrieve PDF
  ↓
Store securely
```

The system should retain enough metadata to trace the stored document back to:

- Gmail account
- Email
- Original attachment
- Invoice requirement
- Underlying transaction

## 11.1 Classification and extraction

A retrieved file is a **Supporting Document**. It is not yet an Invoice.

Every retrieved document passes through the same classification and extraction pipeline as
a manually uploaded one — see `docs/workflows/manual-invoice-upload.md §4–6` and
`docs/architecture.md §17`. The two entry paths converge here, and neither skips it.

The outcome determines what is created:

```text
Retrieved document
        │
        ├── classified as an invoice → Invoice created and linked to the transaction
        │
        └── not classified as an invoice (e.g. a payment confirmation)
                                      → document linked to the transaction as evidence
```

Both outcomes resolve the Invoice Requirement. Only the first creates an Invoice, and so
only the first is subject to the one-to-one Invoice ↔ Transaction rule. See
`docs/domain-model.md §5.1`.

A document that cannot be read at all still resolves nothing on its own, but it remains
stored and available to the user.

---

# 12. Document Association

Each retrieval operation is performed for a **specific invoice requirement**, which is already associated with a specific transaction.

Therefore, when Muneem Ji finds a highly convincing supporting document, it should automatically associate the document with that invoice requirement.

Example:

```text
Transaction
14 April
Anthropic
$20
        ↓
Invoice Requirement
        ↓
Gmail search
        ↓
Anthropic receipt
14 April
$20-ish
        ↓
High-confidence result
        ↓
Document associated with transaction
```

The system does not need to require a separate user action simply to confirm an obviously correct document.

---

# 13. Resolving Multiple Candidates

Gmail may return multiple plausible supporting documents.

Example:

```text
Transaction
14 April
Anthropic
$20

Candidates:

1. Anthropic invoice — April 14 — $20
2. Anthropic invoice — April 14 — $20
3. Anthropic invoice — March 14 — $20
```

The system should evaluate candidates using available signals such as:

- Vendor
- Vendor aliases
- Transaction date
- Document date
- Amount
- Currency
- Email sender
- Email subject
- Invoice number
- Document content
- Other relevant metadata

If one candidate is sufficiently more likely than the others, the system may automatically associate it with the invoice requirement.

If the system cannot confidently resolve the candidates, the requirement should enter a **Needs Review** state.

The user can then resolve the ambiguity through the Invoice Match Review workflow
(`docs/workflows/invoice-match-review.md`).

---

# 14. Document Storage

Retrieved supporting documents should be stored securely outside Gmail so that later workflows can use them without repeatedly retrieving them from Gmail.

Documents are stored in **Vercel Blob** with private access, as fixed by
`docs/architecture.md §6`. This workflow does not choose the storage system.

The system should retain a stable reference to each stored document.

This reference may later be used to:

- Display the document to the user.
- Match the document to a transaction.
- Include the document in reconciliation results.
- Link to the document in the final exported accounting file.

The system should not expose raw storage paths or credentials to the user.

---

# 15. Successful Retrieval

A retrieval is successful when Muneem Ji finds and retrieves a sufficiently convincing supporting document for the invoice requirement.

Example:

```text
Invoice Requirement

Anthropic
$20
14 April

        ↓

Supporting document found

Anthropic Receipt
14 April
Receipt #INV-92831.pdf

        ↓

Automatically associated
with transaction
```

The document remains associated with the underlying invoice requirement and transaction.

---

# 16. No Document Found

Failure to find a supporting document is **not a system failure**.

It is a valid business outcome.

Example:

```text
Invoice Requirement
        ↓
Search connected Gmail accounts
        ↓
No suitable supporting document found
        ↓
NOT_FOUND
```

The requirement should be passed to the **Missing Invoice Report**.

The report should allow the business owner to understand:

- Which transaction requires documentation.
- What expense/vendor it relates to.
- Transaction amount.
- Transaction date.
- That Muneem Ji searched the connected Gmail accounts.
- That no suitable supporting document was found.

The user may then manually locate or upload the document.

---

# 17. Gmail Authorization Problems

A Gmail authorization problem is distinct from an internal system failure.

For example:

```text
Gmail authorization expired
```

may require the user to reconnect the Gmail account.

The system should not repeatedly retry an operation that cannot succeed until the user reauthorizes the account.

The affected requirements enter `BLOCKED` rather than `FAILED`: nothing is wrong on
Muneem Ji's side, and no amount of retrying will help until the user acts.

The user should be informed that action is required.

The reauthorization UX belongs to `docs/workflows/connect-gmail.md`.

---

# 18. Gmail / Infrastructure Failure

Gmail or infrastructure failures should be distinguished from a genuine "no document found" outcome.

### Recoverable failures

Examples:

- Temporary Gmail API failure.
- Network timeout.
- Temporary service unavailability.
- Temporary rate limiting.

The system should automatically retry according to an appropriate retry policy.

### Non-recoverable / internal failures

Examples:

- Invalid system configuration.
- Internal service failure.
- Required infrastructure unavailable.
- Other failures requiring human intervention.

The system should not retry indefinitely.

The appropriate administrator should be notified.

The user should receive a friendly message indicating that Muneem Ji encountered an issue on its side.

Example:

```text
We ran into an issue while looking for your
supporting documents.

Your data is safe, but we weren't able to
complete this step.

We're looking into it and will continue when
the issue is resolved.
```

---

# 19. Multiple Statements and Duplicate Coverage

The retrieval process must preserve the relationship between supporting-document requirements and their underlying transactions.

The system must not create duplicate invoice requirements merely because the same transaction appears in overlapping bank statements.

Example:

```text
Statement A
April 1 – May 9
        ↓
Transaction: May 5

Statement B
May 1 – June 1
        ↓
Same transaction: May 5
```

The transaction should be treated as one business transaction rather than two independent transactions.

The retrieval workflow should therefore operate against the canonical transaction identified by the transaction-processing system.

Duplicate transaction detection and canonical transaction creation are separate concerns and will be defined in the transaction/data model.

---

# 20. Processing States

Retrieval does not have a state model of its own. It advances the state of the **Invoice
Requirement**, which is defined in `docs/state-machines.md §2`.

Retrieval moves a requirement `IDENTIFIED → SEARCHING → EVALUATING`, and from there to:

- `RESOLVED` — a document was confidently associated (section 12),
- `NEEDS_REVIEW` — candidates exist but cannot be resolved automatically (section 13),
- `NOT_FOUND` — the search completed and found nothing suitable (section 16),
- `BLOCKED` — Gmail authorization is required before progress is possible (section 17),
- `FAILED` — an infrastructure or internal error occurred (section 18).

`NEEDS_REVIEW` and `NOT_FOUND` are not terminal. Both await the user, and both lead to
`RESOLVED`.

---

# 21. Output

For each invoice requirement, the workflow should produce or retain:

- Retrieval status.
- Candidate emails.
- Candidate supporting documents.
- Supporting document type, where identifiable.
- Stored document reference, where retrieved.
- Gmail account from which the document was retrieved.
- Relevant email metadata.
- Relationship to the underlying transaction.
- Association confidence, where applicable.
- Retrieval failure information, where applicable.

---

# 22. What Happens Next?

Once retrieval is complete:

### If a document is confidently associated:

```text
Invoice Requirement
        ↓
Supporting Document
        ↓
Classification and extraction
        ↓
RESOLVED
```

### If multiple plausible documents remain:

```text
Invoice Requirement
        ↓
Multiple Candidates
        ↓
NEEDS_REVIEW
        ↓
Invoice Match Review
```

### If no document is found:

```text
Invoice Requirement
        ↓
No Document Found
        ↓
Missing Invoice Report
```

---

# 23. Implementation Boundary

This workflow defines product behavior rather than implementation.

The retrieval system may use:

- Gmail APIs.
- Gmail search.
- Deterministic search criteria.
- LLM-assisted query generation.
- LLM-assisted email/document classification.
- Vendor aliases.
- Business-level memory.
- Candidate ranking.
- Other retrieval techniques.

The exact search and matching implementation should remain replaceable.

The initial implementation should prioritize:

1. Finding relevant supporting documents reliably.
2. Searching all connected Gmail accounts.
3. Correctly associating documents with their specific invoice requirements.
4. Preserving transaction → requirement → document traceability.
5. Correctly distinguishing "not found" from system failure.
6. Secure document storage.
7. Idempotent processing and avoidance of duplicate work.
8. Testability.

Cost and retrieval optimization can be addressed after real usage provides evidence about where optimization is necessary.
