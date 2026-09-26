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

`IDENTIFIED` reads "waiting for a document" rather than "waiting to search", because
searching is one of two ways a document arrives and it is the one that does not exist yet.
Until Gmail retrieval lands, a requirement in `IDENTIFIED` is waiting for the user to
upload something, and telling them we are about to search a mailbox they have not
connected would be a promise the system cannot keep.

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
SEARCHING → EVALUATING ←── a document is uploaded for this transaction
    ↓            ↓
    ↓        NEEDS_REVIEW ──→ RESOLVED
    ↓            ↓
    ↓        NOT_FOUND ──────→ RESOLVED
    ↓
  FAILED / BLOCKED
```

**`EVALUATING` is reached from two directions**, and only one of them passes through
`SEARCHING`. Gmail retrieval searches and then assesses what it found. A manual upload
arrives with the document already in hand, so a requirement in `IDENTIFIED` goes straight
to `EVALUATING` while its candidates are weighed — nothing was searched for, and claiming
otherwise would put a requirement in `SEARCHING` when no mailbox was ever opened.

A requirement may also be in `NOT_FOUND` when an upload arrives, having been looked for
already and not found. It returns to `EVALUATING` for the same reason: there is now
something to assess that there was not before.

| State          | Terminal | Meaning                                                                                                     |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `IDENTIFIED`   | no       | The system determined this transaction needs a supporting document. Nothing has been searched for or offered for it yet. |
| `SEARCHING`    | no       | Connected Gmail accounts are being searched.                                                                |
| `EVALUATING`   | no       | Candidates have been found and are being assessed — documents retrieved for this requirement, or transactions proposed for a document the user uploaded. |
| `NEEDS_REVIEW` | no       | A plausible match exists but the evidence is insufficient to link automatically. Awaiting the user.         |
| `NOT_FOUND`    | no       | Assessment completed and nothing suitable was established — no document was found for the transaction, or no transaction could be established for a document. Awaiting the user. |
| `RESOLVED`     | yes      | A supporting document is linked to the transaction.                                                         |
| `BLOCKED`      | no       | Progress is impossible until the user acts — most often expired Gmail authorization. Distinct from failure. |
| `FAILED`       | no       | An internal or infrastructure error prevented processing. Retryable.                                        |

`NEEDS_REVIEW` and `NOT_FOUND` are **not** terminal. They are the two states that appear
in the Missing Invoice Report's action queue, and both lead to `RESOLVED` once the user
acts. `NOT_FOUND` may also be reached again by a later Reconciliation Run.

### Transitions made by retrieval

The diagram above shows the main path. Gmail retrieval (`docs/workflows/retrieve-invoices.md`,
`docs/decisions/0016`) also needs the edges below, all of them. It makes no transition that is
not listed here.

| From                                              | Event                                              | To             |
| ------------------------------------------------- | -------------------------------------------------- | -------------- |
| `IDENTIFIED`, `NOT_FOUND`, `BLOCKED`, `FAILED`    | a search starts                                    | `SEARCHING`    |
| `SEARCHING`                                       | a search restarts after an infrastructure retry    | `SEARCHING`    |
| `SEARCHING`                                       | documents were fetched                             | `EVALUATING`   |
| `SEARCHING`                                       | nothing worth fetching, every mailbox searched     | `NOT_FOUND`    |
| `SEARCHING`                                       | nothing worth fetching, a mailbox needs reconnecting | `BLOCKED`    |
| `EVALUATING`                                      | settled: one document on strong evidence           | `RESOLVED`     |
| `EVALUATING`                                      | settled: plausible, not strong enough              | `NEEDS_REVIEW` |
| `EVALUATING`                                      | settled: nothing plausible, every mailbox searched | `NOT_FOUND`    |
| `EVALUATING`                                      | settled: nothing plausible, a mailbox unsearched   | `BLOCKED`      |
| `SEARCHING`, `EVALUATING`                         | infrastructure failure, retries exhausted          | `FAILED`       |

Why each entry into `SEARCHING` exists:

- **`NOT_FOUND → SEARCHING`**: each new Reconciliation Run searches again, because invoices
  arrive late. Documents the user rejected are never offered again.
- **`BLOCKED → SEARCHING`**: happens when the user reconnects the mailbox that was blocking
  it (`connect-gmail.md §9`).
- **`FAILED → SEARCHING`**: happens on the next run. `FAILED` is retryable by definition.

A requirement with no mailbox to search — none was ever connected, or every one is
`DISCONNECTED` — stays `IDENTIFIED`. Connecting a mailbox is optional (`connect-gmail.md §3`),
so not having one is not `BLOCKED`.

No retrieval write ever touches a requirement that already has a resolution method. That is
the same guard `src/matching/link.ts` uses.

### Mailbox search outcome

A field on each Mailbox Search, one per requirement per Gmail Connection. It records what
happened when that mailbox was searched for that requirement. It is not a state; nothing moves
through it.

| Outcome        | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `COMPLETED`    | The mailbox was searched over the whole window.                         |
| `NEEDS_REAUTH` | The mailbox could not be searched until the user reconnects it.         |
| `FAILED`       | The mailbox could not be searched because of an infrastructure failure. |

### Fetch outcome

A field on each Candidate Email. Null means it was not selected for fetching.

| Outcome         | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `FETCHED`       | At least one attachment was stored as a Supporting Document.         |
| `NO_ATTACHMENT` | The message had no attachment the system retrieves (PDF, in V1).     |
| `MESSAGE_GONE`  | The message no longer existed when it was fetched.                   |

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

`IDENTIFIED` reads "waiting for a document" rather than "waiting to search", because
searching is one of two ways a document arrives and it is the one that does not exist yet.
Until Gmail retrieval lands, a requirement in `IDENTIFIED` is waiting for the user to
upload something, and telling them we are about to search a mailbox they have not
connected would be a promise the system cannot keep.

| State          | Message                          |
| -------------- | -------------------------------- |
| `IDENTIFIED`   | Waiting for a document           |
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

## 6. Gmail Connection

The health of one Google account's authorization to be read, within one Workspace
(`docs/workflows/connect-gmail.md §7`).

```text
(first grant) ──→ CONNECTED ⇄ NEEDS_REAUTH
                      ↓            ↓
                  DISCONNECTED ←───┘
                      ↓ (granted again: the same record)
                  CONNECTED
```

| State          | Meaning                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `CONNECTED`    | Authorization is valid and retrieval may use this account.                                     |
| `NEEDS_REAUTH` | The grant expired or was revoked. Retrieval cannot use this account until the user reconnects. |
| `DISCONNECTED` | The user removed the connection. Credentials deleted.                                          |

None is terminal. Every state can be left by the user acting.

| From                        | Event                          | To             |
| --------------------------- | ------------------------------ | -------------- |
| — (no record yet)           | granted                        | `CONNECTED`    |
| `CONNECTED`                 | granted (reconnected)          | `CONNECTED`    |
| `NEEDS_REAUTH`              | granted (reconnected)          | `CONNECTED`    |
| `DISCONNECTED`              | granted (connected again)      | `CONNECTED`    |
| `CONNECTED`                 | Google reports the grant invalid | `NEEDS_REAUTH` |
| `CONNECTED`, `NEEDS_REAUTH` | the user disconnects           | `DISCONNECTED` |

Anything not in this table is refused. In particular:

- **`DISCONNECTED` never becomes `NEEDS_REAUTH`.** It holds no credentials, so there is no
  grant for Google to call invalid.
- **Only an invalid grant produces `NEEDS_REAUTH`.** Rate limiting, timeouts and 5xx
  responses are transient and leave the state alone (`connect-gmail.md §8`). A connection
  must never be marked broken because Google was briefly unavailable.
- **A grant always lands on the existing record** for that Google account in that
  Workspace, whatever state it is in. Reconnecting restores; it never creates a second.

`DISCONNECTED` is a state rather than a deleted row on purpose: documents retrieved through
the connection keep a provenance that points at something, and connecting the same account
again restores the record rather than starting a new history.

The database holds credentials exactly when the state is not `DISCONNECTED`. That is a
constraint, not a convention.

### User-facing messages

| State          | Message          |
| -------------- | ---------------- |
| `CONNECTED`    | Connected        |
| `NEEDS_REAUTH` | Reconnect needed |
| `DISCONNECTED` | Disconnected     |

---

## 7. Retired state names

These appear in earlier revisions of the workflow documents. They map onto the above.

| Retired                                   | Replacement                                        |
| ----------------------------------------- | -------------------------------------------------- |
| `INVOICE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` | Invoice Requirement `NOT_FOUND`                    |
| `DOCUMENT_FOUND`, `DOCUMENT_RETRIEVED`    | Invoice Requirement `RESOLVED` + `AUTO_RETRIEVED`  |
| `USER_ACTION_REQUIRED`                    | Invoice Requirement `BLOCKED`                      |
| `PENDING`                                 | Invoice Requirement `IDENTIFIED`                   |
| `LEARNING`, `ASKING`                      | Not requirement states; see Clarification Question |
| `DISCREPANCY` as a statement state        | Statement validation outcome                       |
