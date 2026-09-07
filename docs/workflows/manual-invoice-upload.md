# Manual Invoice Upload Workflow

## 1. Purpose

The Manual Invoice Upload workflow allows a user to upload an invoice directly into the system at any time.

Manual upload is always available as an independent action, but it is also explicitly surfaced when the Missing Invoice Report identifies invoices that could not be found automatically.

The workflow accepts both digital and physical invoices. Uploaded documents may therefore be:

- PDF documents
- Images of any supported common image format
- Photographs of physical invoices

The system must process both PDFs and images using appropriate text extraction and OCR capabilities.

The objective is not merely to store the uploaded file. The system should attempt to:

1. determine whether the document is an invoice,
2. extract and normalize invoice information,
3. identify the corresponding bank transaction,
4. reconcile the invoice against that transaction,
5. detect possible duplicates,
6. update the invoice's status in the Missing Invoice Report.

If automatic processing or matching fails, the user must be given a clear path to manually link the uploaded document to a transaction.

---

## 2. Entry Points

Manual Invoice Upload can be initiated in two ways.

### A. Direct upload

The user can manually upload an invoice at any time from the relevant invoice/document interface.

This option remains available regardless of whether there are currently missing invoices.

### B. Missing Invoice Report

When the Missing Invoice Report identifies missing invoices, the user is prompted to upload them manually.

The report should provide a clear action such as:

> Upload invoice

Selecting this action starts the same Manual Invoice Upload workflow.

### C. Invoice Match Review

The user resolving a specific requirement chooses to upload the document
(`docs/workflows/invoice-match-review.md §6`).

This entry point differs in one respect: the transaction is already known. Candidate
generation and matching (sections 8–10) are skipped entirely — the user has already
answered the question matching exists to answer. Classification, extraction, and duplicate
detection still run.

All entry points converge on the same processing and reconciliation logic.

---

## 3. Upload

The user selects and uploads an invoice document.

Supported inputs:

- PDF
- Image files
- Photographs of physical invoices

The system should accept invoices regardless of their visual layout or formatting.

The uploaded file is retained as the invoice document if processing succeeds or if the user subsequently chooses to manually link it.

---

## 4. Document Processing

After upload, the system determines how the document should be processed.

### PDF

If machine-readable text is available, the system should extract the text directly.

If the PDF does not contain usable text, the system should use OCR.

### Image

Images are processed using OCR.

OCR should be capable of handling photographs of physical invoices rather than assuming that all uploads are clean digital documents.

The output of this stage is the available document text and associated extraction confidence/evidence.

---

## 5. Invoice Classification

The system determines whether the uploaded document appears to be an invoice.

The system should distinguish between:

- Successfully identified invoice
- Unable to confidently determine whether the document is an invoice
- Document appears not to be an invoice

The system should avoid presenting uncertain classifications as absolute facts.

If the system cannot confidently identify the document as an invoice, the user should be informed:

> We couldn't identify this document as an invoice.

The user should still have the option to manually link the document to a transaction.

Manual linking acts as an explicit user override.

---

## 6. Invoice Extraction and Normalization

For documents identified as invoices, the system extracts the available invoice information and converts it into a normalized representation.

### Core invoice fields

The system should attempt to extract:

- Vendor legal name
- Vendor trade name
- Vendor aliases / alternate names
- Invoice number
- Invoice date
- Total amount
- Currency
- Tax amount
- Subtotal, where available

Not every field is expected to exist on every invoice.

In particular, invoice number should not be treated as universally mandatory.

The minimum useful information for automatic reconciliation is generally:

- Vendor identity
- Total amount
- Invoice date or another meaningful date
- Sufficient evidence that the document represents an invoice

Additional fields strengthen the reconciliation but should not unnecessarily prevent a valid invoice from being processed.

---

## 7. Vendor Normalization

Vendor identity must be normalized before matching.

The system should account for differences between:

- Legal name
- Trade name
- Abbreviated name
- Known aliases
- Formatting variations
- Payment processor prefixes
- Bank statement descriptions

For example:

`ABC Foods Private Limited`

may correspond to:

`ABC Foods`

and a bank description such as:

`RAZORPAY*ABCFOODS`

These should be capable of resolving to the same underlying vendor.

Deterministic normalization should be used where possible, with semantic/LLM-based reasoning used for more ambiguous cases.

---

## 8. Transaction Candidate Generation

The system should not ask an LLM to search the entire bank statement for a matching transaction.

Instead, the matching engine should first generate a small set of plausible transaction candidates using available structured information.

Candidate generation may consider:

- Vendor similarity
- Vendor aliases
- Transaction amount
- Currency
- Invoice date
- Transaction date
- Transaction description
- Debit/credit direction
- Other normalized transaction metadata

Date and amount matching should be tolerant rather than requiring exact equality.

For example, an invoice dated one day may legitimately correspond to a bank transaction occurring several days later due to payment or settlement timing.

Similarly, currencies may differ where a foreign-currency invoice results in a local-currency bank transaction.

---

## 9. Matching and Reconciliation

The reconciliation engine evaluates whether the uploaded invoice corresponds to one of the candidate bank transactions.

Matching should be evidence-based rather than dependent on exact field equality.

Relevant evidence includes:

### Vendor identity

Strong evidence when the invoice vendor and transaction merchant resolve to the same vendor or known alias.

### Amount

Strong evidence when the invoice amount corresponds to the transaction amount.

Exact amount matches should receive stronger evidence than approximate matches.

Currency differences should be considered rather than automatically treated as a mismatch.

### Date

Invoice and transaction dates should be compared using a reasonable tolerance window rather than requiring exact equality.

### Invoice number

Where available, the invoice number provides strong corroborating evidence, particularly where it appears in the transaction description or related records.

### Other document/transaction evidence

Additional extracted information may be used where useful.

A stronger LLM may be used for the final reconciliation step when the invoice format, vendor identity, or transaction description requires semantic interpretation.

The LLM should receive the normalized invoice information and a constrained set of transaction candidates rather than being responsible for unrestricted transaction search.

---

## 10. Reconciliation Outcomes

The reconciliation engine should produce one of three broad outcomes:

### High-confidence match

The available evidence strongly indicates that the invoice corresponds to a specific transaction.

The system may automatically link the invoice to that transaction.

### Review required

The system has identified a plausible match but the evidence is insufficient for automatic linking.

The requirement enters `NEEDS_REVIEW` and the user resolves it through
`docs/workflows/invoice-match-review.md`.

### No reliable match

The system cannot establish a sufficiently reliable relationship between the invoice and any candidate transaction.

The user is offered the option to manually link the invoice to a transaction.

Exact confidence thresholds are intentionally left undefined at this stage and should be established through evaluation against representative invoice and transaction data.

---

## 11. OCR / Extraction Failure

If the system is unable to obtain usable information from the uploaded document, it should not simply reject the upload.

The user should be told:

> We couldn't read the details from this document.

The user can then manually link the uploaded document to the relevant bank transaction.

The uploaded document remains available as the invoice document, while the transaction relationship is established through explicit user confirmation.

---

## 12. Manual Transaction Linking

Manual linking is the final fallback whenever automatic reconciliation is unsuccessful.

The user selects the transaction that the invoice belongs to.

The system should present relevant transaction information, such as:

- Merchant/description
- Amount
- Currency
- Transaction date

Once the user confirms the relationship, the invoice is considered linked to that transaction.

The user-confirmed relationship should be treated as authoritative for the current record.

Manual confirmations may also provide valuable data for future matching-engine evaluation and improvement.

---

## 13. Duplicate Detection

Before creating a new invoice record, the system should check whether an equivalent invoice has already been identified.

This is particularly important when:

1. an invoice was previously retrieved from Gmail, and
2. the user subsequently uploads the same invoice manually.

If the system identifies a likely duplicate, it should not silently create a second invoice.

The user should be shown the existing invoice and the newly uploaded document and asked to review the relationship.

Where the documents are clearly identical, the system may communicate:

> This appears to be the same invoice we already found.

The user should retain control over which document is kept as the primary invoice where necessary.

---

## 14. Invoice Commitment

An uploaded file is a **Supporting Document** from the moment it is stored. It becomes an
**Invoice** only once classified and extracted as one; a receipt or payment confirmation
that resolves the requirement without being classifiable as an invoice remains a Supporting
Document linked to the transaction. See `docs/domain-model.md §5.1`.

An invoice becomes part of the user's invoice records once the document has been successfully processed or explicitly linked by the user.

The Invoice Requirement reaches `RESOLVED` with the corresponding resolution method
(`docs/state-machines.md §2`): `AUTO_MATCHED`, `USER_CONFIRMED`, or `USER_LINKED`. An
upload that resolves nothing yet leaves the requirement in `NEEDS_REVIEW`.

An upload with no requirement to resolve — the user uploading an invoice for a transaction
the system never flagged — still creates the document and the Invoice, and may be linked to
a transaction later.

The uploaded document itself should remain associated with the invoice record.

---

## 15. Missing Invoice Report Integration

The Manual Invoice Upload workflow must update the Missing Invoice Report after successful reconciliation.

For example:

**Before upload**

> 12 documents required
> 8 matched
> 4 not found

After successfully uploading and matching one:

> 12 documents required
> 9 matched
> 3 not found

The denominator is Invoice Requirements, not transactions processed. See the counting
contract in `docs/workflows/missing-invoice-report.md §5`.

The report reflects the current state of reconciliation rather than treating manually
uploaded documents separately.

Where useful, the report may distinguish how an invoice was resolved:

- Retrieved automatically
- Uploaded manually
- Manually linked
- Requires review

---

## 16. Download

The user must retain the ability to download the invoice file after it has been successfully uploaded.

The downloaded document should be the original uploaded file rather than an OCR-generated representation, unless the product explicitly introduces document conversion later.

---

## 17. Key Principles

### Manual upload is always available

The user does not need to wait for a missing-invoice workflow to use manual upload.

### Upload does not equal successful reconciliation

A file being uploaded is separate from establishing that it is an invoice and linking it to a transaction.

### OCR failure does not mean workflow failure

The system should fall back to manual transaction linking.

### Classification uncertainty does not mean rejection

If the system cannot confidently identify a document as an invoice, the user should be allowed to manually link it.

### Matching is evidence-based

No single field should necessarily determine the result in isolation.

### Vendor identity is normalized

Legal names, trade names, aliases, and bank/payment-processor descriptions should be capable of resolving to the same vendor.

### Stronger reasoning is reserved for ambiguity

Deterministic normalization and candidate generation should narrow the problem before stronger LLM-based reconciliation is used.

### User confirmation is authoritative

When the system cannot confidently determine the correct transaction, the user can explicitly establish the relationship.

### All successful paths converge

Whether a document arrives through Gmail retrieval or manual upload, it passes through the
same classification, extraction, and normalization pipeline, and resolves the same Invoice
Requirement. Retrieval does not have a shortcut around it
(`docs/workflows/retrieve-invoices.md §11.1`).

The paths differ only in what is known on arrival: retrieval already knows the transaction,
direct upload does not.
