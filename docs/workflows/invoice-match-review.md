# Invoice Match Review

## 1. Actor

**Business Owner**

---

## 2. Goal

Let the user resolve a single Invoice Requirement that automation could not resolve on its
own, with enough context to decide quickly and correctly.

This is where every uncertain path in the system terminates. Gmail retrieval that found
several plausible documents, a manual upload that matched nothing, an unreadable scan, a
suspected duplicate — all of them end here, in front of the user, and all of them leave
here `RESOLVED` or deliberately left open.

---

## 3. Entry points

| From                                          | Requirement state             |
| --------------------------------------------- | ----------------------------- |
| Missing Invoice Report action queue           | `NEEDS_REVIEW` or `NOT_FOUND` |
| Retrieval found multiple plausible candidates | `NEEDS_REVIEW`                |
| Manual upload produced no reliable match      | `NEEDS_REVIEW`                |
| Manual upload produced a suspected duplicate  | `NEEDS_REVIEW`                |
| Document could not be read                    | `NEEDS_REVIEW`                |

All entry points converge on the same screen and the same resolution logic. The user
should not be able to tell from the interface which pipeline produced the uncertainty —
only what the decision in front of them is.

---

## 4. Context shown

Always shown, because the decision is meaningless without it:

**The transaction** — date, amount, currency, description as it appeared on the statement,
bank account, and why the system believes a document is required.

**What the system did** — which Gmail accounts were searched, over what date window, and
what it found. A user told "no invoice found" deserves to know whether that means "we
looked in three mailboxes across two weeks" or "we never got to look".

**The candidates**, where any exist.

---

## 5. Resolving with a candidate

Each candidate is presented with the evidence for it, not merely a score:

```text
Anthropic — Receipt — 14 April — $20.00
From: receipts@anthropic.com
Attachment: Receipt-INV-92831.pdf

  Vendor matches ANTHROPIC in the transaction description
  Amount matches exactly
  Dated the same day as the transaction
  Invoice number not present in the transaction description

[Preview]  [This is the one]
```

Confidence is shown as the evidence that produced it. A percentage tells the user nothing
they can check; "the amount matches and the date is the same" tells them everything.

The user may preview the document before deciding. The preview serves the original stored
file through an authorized application route, never a public storage URL
(`docs/architecture.md §19`).

Choosing a candidate resolves the requirement with method `USER_CONFIRMED`.

---

## 6. Resolving without a candidate

Three other outcomes are available from the same screen:

### Upload the document

Enters `manual-invoice-upload.md`, pre-bound to this transaction. Because the transaction
is already known, the matching stage is skipped entirely — the user has already answered
the question matching exists to answer.

Resolves with method `USER_LINKED`.

### Link an existing document

The user picks a document already in the Workspace. Used when an invoice was retrieved
against the wrong transaction, or covers a payment the system did not connect it to.

Resolves with method `USER_CONFIRMED`.

### No document is needed

The user states that this transaction does not require supporting documentation — a
personal payment, an internal transfer, a bank fee.

Resolves with method `NOT_REQUIRED`, and is the single most valuable answer the user can
give, because it is the one that stops the system asking again.

---

## 7. Rejecting all candidates

If none of the candidates is right, the user says so.

The requirement returns to `NOT_FOUND`, and the rejected candidates are recorded so that a
later run does not present them again.

Rejection is evidence. It should never be discarded, and it should never be treated as the
user having taken no action.

---

## 8. Duplicates

When the entry point is a suspected duplicate, the question is different: not "which
transaction", but "are these the same invoice".

Both documents are shown side by side with the fields that agree and disagree.

```text
This appears to be the same invoice we already found.

Already on file             Just uploaded
Anthropic                   Anthropic
INV-92831                   INV-92831
14 April · $20.00           14 April · $20.00

[Same invoice — keep one]   [Different invoices]
```

If the same: both files are retained as documents of one Invoice, and the user chooses
which is primary. Nothing is deleted — the user asked to deduplicate a record, not to
destroy a file.

If different: a separate Invoice is created and matched independently.

---

## 9. What is learned

A user decision may produce Business Knowledge, but only what the decision actually
supports.

| Decision                                                                    | Learned                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Confirmed a candidate whose vendor differs from the transaction description | The alias, confirmed                                            |
| Marked a transaction as needing no document                                 | The pattern, for similar future transactions                    |
| Rejected every candidate                                                    | Nothing about the vendor; only that these candidates were wrong |

The system must not over-generalize from one confirmation. One user confirming an Adobe
receipt does not establish that every `RAZORPAY*` transaction is Adobe. Where the
generalization is uncertain, ask rather than assume — and ask once.

---

## 10. Leaving without deciding

The user may leave at any point. The requirement keeps its state, nothing is lost, and it
remains in the action queue.

A user who cannot answer right now must never be forced to guess. A guessed match is worse
than an unresolved one: it is wrong and it looks resolved.

---

## 11. Outcome

Every path either:

- resolves the requirement — `RESOLVED`, with the method recorded, or
- returns it to the action queue — `NEEDS_REVIEW` or `NOT_FOUND`.

The Missing Invoice Report reflects the change immediately.

---

## 12. Implementation boundary

This workflow performs no searching, retrieval, or matching. Those have already happened.

Its responsibilities are: present the evidence honestly, capture the user's decision, apply
it, and persist only what the decision genuinely supports.
