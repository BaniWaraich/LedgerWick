# State Machines

The authoritative state definitions for the system.

Workflow documents describe _when_ a transition happens. This document defines _what the
states are_. Where a workflow document lists states, it is describing these; where the
two disagree, this document wins.

Rules:

- One object owns one state field. Outcomes that are not states are modelled separately.
- State names here are the identifiers used in code and in the database.
- User-facing wording is a presentation concern and is listed separately from the state.

---

## 1. Bank Statement

The processing lifecycle of one uploaded file.

```text
UPLOADING → IDENTIFYING → PARSING → VALIDATING → COMPLETED
                  ↓                           ↘
            NEEDS_ACCOUNT → PARSING             FAILED
```

`FAILED` is reachable from any non-terminal state.

`NEEDS_ACCOUNT` is the one place this machine waits for a person. The workflow that
reached it has completed; the pause is this state in the database, not a suspended
execution (`docs/architecture.md §12C`). The user choosing or creating an account is what
moves it on.

| State         | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `UPLOADING`   | Bytes are being transferred and stored.                                       |
| `IDENTIFYING` | Determining whether the file is a bank statement, and for which bank/account. |
| `NEEDS_ACCOUNT` | The file is a bank statement, but the document does not say which account it covers. Awaiting the user. |
| `PARSING`     | Extracting statement lines and balances.                                      |
| `VALIDATING`  | Checking the extracted data against the statement's own balances.             |
| `COMPLETED`   | Processing finished. See the validation outcome below.                        |
| `FAILED`      | Processing could not complete. A failure reason is recorded.                  |

### Validation outcome

A separate field, meaningful only when the state is `COMPLETED`.

| Outcome       | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `VALID`       | Opening balance + credits − debits = closing balance.          |
| `DISCREPANCY` | Processing succeeded but the extracted lines do not reconcile. |

`DISCREPANCY` is **not** a processing state. A statement with a discrepancy was processed
successfully; the system simply does not trust the result. It is surfaced to the user as
an action, not as a failure.

### Period source

A separate field recording how the statement's period is known. Null until it is.

| Value      | Meaning                                                                      |
| ---------- | ---------------------------------------------------------------------------- |
| `DECLARED` | The document stated the period it covers, and this is what it stated.        |
| `DERIVED`  | The document stated no period; the range is that of the transactions parsed. |

Identification only ever produces `DECLARED`. A document that declares no period is not a
failure — it proceeds with no period at all, and parsing supplies a `DERIVED` one. See
`docs/decisions/0008-statement-period-provenance.md`.

### Account kind

A field on the Bank Account a statement is bound to, not on the statement.

| Value          | Meaning                       |
| -------------- | ----------------------------- |
| `BANK_ACCOUNT` | An account held at a bank.    |
| `CREDIT_CARD`  | A credit card account.        |

Neither of these is a state. They are listed here because `src/db/schema.ts` takes its
enumerated values from this document.

### User-facing messages

| Condition                   | Message                                       |
| --------------------------- | --------------------------------------------- |
| `UPLOADING`                 | Uploading your statement…                     |
| `IDENTIFYING`               | Identifying your bank…                        |
| `NEEDS_ACCOUNT`             | Tell us which account this statement covers.  |
| `PARSING`                   | Extracting transactions…                      |
| `VALIDATING`                | Checking your transactions…                   |
| `COMPLETED` + `VALID`       | Statement processed.                          |
| `COMPLETED` + `DISCREPANCY` | We found something that needs your attention. |
| `FAILED`                    | We couldn't process this statement.           |

---

## 2. Invoice Requirement

The state of one requirement, from identification through to resolution. This is the
single state machine that the Missing Invoice Report reads.

```text
IDENTIFIED
    ↓
SEARCHING → EVALUATING
    ↓            ↓
    ↓        NEEDS_REVIEW ──→ RESOLVED
    ↓            ↓
    ↓        NOT_FOUND ──────→ RESOLVED
    ↓
  FAILED / BLOCKED
```

| State          | Terminal | Meaning                                                                                                     |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `IDENTIFIED`   | no       | The system determined this transaction needs a supporting document. Retrieval has not started.              |
| `SEARCHING`    | no       | Connected Gmail accounts are being searched.                                                                |
| `EVALUATING`   | no       | Candidate documents have been found and are being assessed.                                                 |
| `NEEDS_REVIEW` | no       | A plausible match exists but the evidence is insufficient to link automatically. Awaiting the user.         |
| `NOT_FOUND`    | no       | Searching completed and no suitable supporting document was found. Awaiting the user.                       |
| `RESOLVED`     | yes      | A supporting document is linked to the transaction.                                                         |
| `BLOCKED`      | no       | Progress is impossible until the user acts — most often expired Gmail authorization. Distinct from failure. |
| `FAILED`       | no       | An internal or infrastructure error prevented processing. Retryable.                                        |

`NEEDS_REVIEW` and `NOT_FOUND` are **not** terminal. They are the two states that appear
in the Missing Invoice Report's action queue, and both lead to `RESOLVED` once the user
acts. `NOT_FOUND` may also be reached again by a later Reconciliation Run.

### Resolution method

A separate field on a `RESOLVED` requirement, recording how the link was established.

| Method           | Meaning                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `AUTO_RETRIEVED` | Retrieved from Gmail and linked automatically on strong evidence.    |
| `AUTO_MATCHED`   | Matched automatically from a manually uploaded document.             |
| `USER_CONFIRMED` | The user chose among candidates the system proposed.                 |
| `USER_LINKED`    | The user linked a document to a transaction with no system proposal. |
| `NOT_REQUIRED`   | The user determined no document is needed for this transaction.      |

`NOT_REQUIRED` is a legitimate resolution. A user saying "this doesn't need an invoice"
resolves the requirement and teaches the system something; see Business Knowledge in
`docs/glossary.md`.

### User-facing messages

| State          | Message                          |
| -------------- | -------------------------------- |
| `IDENTIFIED`   | Waiting to search…               |
| `SEARCHING`    | Looking through your email…      |
| `EVALUATING`   | Checking what we found…          |
| `NEEDS_REVIEW` | Needs your review                |
| `NOT_FOUND`    | We couldn't find this one        |
| `RESOLVED`     | Matched                          |
| `BLOCKED`      | Reconnect your email to continue |
| `FAILED`       | We hit a problem — we'll retry   |

---

## 3. Supporting Document

The processing lifecycle of one stored file, independent of whether it ends up
satisfying a requirement.

```text
STORED → EXTRACTING → CLASSIFYING → EXTRACTED
              ↓             ↓    ↘
              └──→ UNREADABLE     NOT_AN_INVOICE
```

| State            | Meaning                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| `STORED`         | The original bytes are safely stored. Reached before any processing is attempted. |
| `EXTRACTING`     | Text extraction or OCR in progress.                                               |
| `CLASSIFYING`    | Determining whether the document is an invoice.                                   |
| `EXTRACTED`      | Invoice information was obtained. An Invoice record exists or can be created.     |
| `UNREADABLE`     | The document's details could not be obtained. From either stage.                  |
| `NOT_AN_INVOICE` | The document was read but does not appear to be an invoice or receipt.            |

`UNREADABLE` and `NOT_AN_INVOICE` are outcomes, not failures. The document remains stored
and the user may still link it manually — see `docs/architecture.md §15`. A document that
reaches `STORED` is never deleted by an automated process.

**`UNREADABLE` is reached from either stage**, because there are two ways to end up without
the details and the user's position is the same in both. Extraction reaches it when no text
and no OCR result could be obtained at all. Classification reaches it when the document was
read but nothing usable came back — the model could not answer, or answered in a way that
did not survive its schema, or named no vendor, no amount and no date.
`docs/workflows/manual-invoice-upload.md §11` gives the user-facing sentence for both:
*"We couldn't read the details from this document."* Details, not text.

**There is no `FAILED` state, deliberately.** Infrastructure failure — a provider timeout, a
gateway with no credit, a cold database — is not a fact about the document, and recording it
on the document would make a retry look like a verdict. Such a document stays in
`EXTRACTING` or `CLASSIFYING` and the background workflow retries it. That is the line
`docs/definition-of-done.md` asks to be drawn between recoverable and non-recoverable
failure: the non-recoverable half is a document a model read and could not make sense of,
and `UNREADABLE` is where it lands.

### Classification confidence

Classification is three-valued and must not be flattened to a boolean:

| Value            | Meaning                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `IS_INVOICE`     | Confidently an invoice or receipt.                                            |
| `UNCERTAIN`      | Could not determine. Presented to the user as uncertainty, not as a negative. |
| `IS_NOT_INVOICE` | Confidently not an invoice.                                                   |

---

## 4. Reconciliation Run

```text
RUNNING → COMPLETED
       ↘
         FAILED
```

| State       | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `RUNNING`   | The pipeline is executing over this Workspace.                                             |
| `COMPLETED` | Every requirement in the run reached a state that needs no further automated work.         |
| `FAILED`    | The run aborted. Requirements retain whatever state they reached; work is not rolled back. |

A run reaching `COMPLETED` does not mean every requirement is `RESOLVED`. It means
automation has done what it can and the remainder is the user's.

---

## 5. Clarification Question

A question raised for the Business Owner when identification cannot determine what a
transaction is on its own (`docs/domain-model.md §3.15`).

```text
OPEN → ANSWERED
```

| State      | Terminal | Meaning                                                                |
| ---------- | -------- | ---------------------------------------------------------------------- |
| `OPEN`     | no       | Raised and waiting. The user may not have seen it yet.                 |
| `ANSWERED` | yes      | The user answered. The answer is recorded against the question.        |

**This is not an enum.** Unlike every other state machine here, the state is derived from
whether `answered_at` is set. Two states with no intermediate and no way back do not earn a
column of their own, and a second field that must agree with the first is a second thing to
get wrong. Named here because a state must be in this document to exist at all, not because
it needs storage.

Three rules that are properties of this machine rather than of any workflow:

- **A run never waits on it.** `identifying-invoices.md §6` makes "awaiting answers" a
  non-blocking stage, and `docs/architecture.md §12C` forbids a background workflow suspended
  on a human. Identification raises the question and continues.
- **An unanswered question outlives its run.** The user may be away when it is raised. A run
  reaching `COMPLETED` or `FAILED` never closes, discards or expires an `OPEN` question.
- **Answering is not the same as learning.** An answer becomes Business Knowledge only where
  it generalizes beyond the transaction that prompted it (`docs/domain-model.md` invariant
  18). `ANSWERED` records that the user replied, not that anything was written elsewhere.

---

## 6. Retired state names

These appear in earlier revisions of the workflow documents. They map onto the above.

| Retired                                   | Replacement                                        |
| ----------------------------------------- | -------------------------------------------------- |
| `INVOICE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` | Invoice Requirement `NOT_FOUND`                    |
| `DOCUMENT_FOUND`, `DOCUMENT_RETRIEVED`    | Invoice Requirement `RESOLVED` + `AUTO_RETRIEVED`  |
| `USER_ACTION_REQUIRED`                    | Invoice Requirement `BLOCKED`                      |
| `PENDING`                                 | Invoice Requirement `IDENTIFIED`                   |
| `LEARNING`, `ASKING`                      | Not requirement states; see Clarification Question |
| `DISCREPANCY` as a statement state        | Statement validation outcome                       |
