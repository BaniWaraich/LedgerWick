# When retrieval is done

## Why this document exists

This is the fourth of these, after `docs/parsing-acceptance.md`,
`docs/extraction-acceptance.md` and `docs/matching-acceptance.md`, and it is written before
the fact for the reason the matching log gives. A wrong automatic link satisfies every check
the system has:

- the requirement is `RESOLVED`;
- the one-to-one invariant holds;
- the report's numbers add up;
- the Excel export shows a document beside the payment.

It is wrong only when you hold the email, the PDF and the bank statement side by side.

Retrieval adds a way to be wrong that matching alone does not have. It chooses what to put
in front of matching at all. An invoice it never searched for is an invoice the user has to
find by hand. An invoice for a different payment that it did find can be read perfectly and
still be the wrong one.

So the evidence for feature K is two things, kept apart:

1. **The policy**, measured by a deterministic evaluation that runs in `npm test`.
2. **The models on real mail**, measured by a person, in the log below.

---

## 1. The policy — deterministic, in the suite

`tests/retrieval/eval.test.ts` runs a labelled set of messy mailboxes through the whole
pipeline: search, select, fetch, understand, match and settle. The reader is scripted, and
the adjudicator **agrees with every proposal it is shown**, which is the worst adjudicator
the policy could have. The set covers:

- an alias the bank printed;
- a forwarded invoice with a generic filename;
- Indian digit grouping;
- the same PDF sent twice, and the same mail in two mailboxes;
- two invoices for one payment;
- tax, FX and date drift;
- the vendor's newsletter;
- an HTML-only receipt;
- last month's invoice arriving inside this month's window;
- an identical charge on another day that owns the invoice that was found.

It asserts **zero false-positive automatic links**, and one expected outcome per case. It
prints the summary below on every run. The rows here were recorded when the set was written
(2026-09-26):

| Measure                    | Value |
| -------------------------- | ----- |
| Cases                      | 21    |
| Automatic-link precision   | 1.00  |
| Automatic-link recall      | 1.00  |
| False positives            | 0     |
| False negatives            | 0     |
| Review rate                | 0.33  |
| Not-found rate             | 0.24  |

**Read this for what it is.** A scripted reader cannot misread, so recall of 1.00 says the
policy links what it should *when the reading is right*, not that the reading is right. What
the set does establish is the property the design exists for. With a model that agrees with
everything, the deterministic terms alone still refuse every wrong link in it.

When the set was written, it was checked that the eval can fail. Removing the "matching
chose this payment for it" term produced five false positives and six mislabelled cases.

**Every retrieval bug donates a case to this set,** exactly as every parsing bug donates a
fixture.

---

## 2. The models on real mail — kept by a person

### The measurement that matters

**First-attempt correctness on requirements the system has never seen, with false
positives counted separately.** The same rule every log here follows:

> A false positive costs more than asking the user … treat any increase in false positives
> as a regression even when the aggregate score improved.
> — `docs/testing-strategy.md`

### A requirement gets one first impression

**Run the bench on a new requirement, record the outcome, and only then fix anything.** A
mailbox used as a bug report becomes training data.

### What each outcome means, ranked

| Outcome | Meaning | Cost |
| --- | --- | --- |
| **Correct link** | Linked automatically, to the right document. | None. |
| **Correct review** | Sent to the user, and the answer was not obvious. | Ten seconds. |
| **Unnecessary review** | Sent to the user, and the answer was plainly there. | Attention, and trust in the queue. |
| **Missed document** | `NOT_FOUND` while the right document was in a searched mailbox. | The user does the product's job. |
| **Wrong outcome kind** | `NOT_FOUND` for a mailbox never searched, or `BLOCKED` for one that was. | The user is told something false about what happened. |
| **False positive** | Linked automatically, to the wrong document. | **Wrong accounts, silently.** |

### What "passed" means for one requirement

A requirement passes only if **all** of these hold:

- **The outcome is correct**, and for the right reason. Read the terms in `decision.txt`,
  not just the verdict.
- **No false positive**, for this requirement or any other the run touched.
- **The right emails were looked at.** If the invoice was in the mailbox, its email was
  selected. A missed selection is a finding about search, even when review caught it.
- **The evidence shown is true.** Every sentence can be checked against the email and the
  PDF.
- **Re-running produces nothing new.** No second document, invoice or candidate set.

### The bar

**Six consecutive unseen requirements retrieved correctly on first attempt, with no code
change between them, and zero false positives across the whole log.**

This gates **Phase 1**, not feature K. `docs/phases/phase-1.md §7 K` carries the same split D,
F and G carry. It waits on `BAN-149` (gateway credit) and `BAN-157` (a labelled test mailbox).

Current streak: **0**. First-attempt outcomes: **0 of 0**. False positives: **0 of 0**.

### The log

One row per requirement, written **before** anything is fixed.

| # | Requirement | Outcome | Correct? | Blocked by | Emails selected / found | What it taught |
| - | ----------- | ------- | -------- | ---------- | ----------------------- | -------------- |
| _(none yet — the gateway has no credit, `BAN-149`)_ |

`Blocked by` is the settle term that stopped an automatic link, or the matching term behind
it. The bench prints both.

---

## The numbers this replaces

Every number in `src/retrieval/thresholds.ts` except the window is a safety valve rather
than a quality threshold. None can cause a wrong link, because linking reads none of them.
The questions the log has to answer:

- **`SEARCH_WINDOW_DAYS`** (7, from the spec): how many real invoices arrived outside it?
- **`MAX_MESSAGES_FETCHED`** (5): how often did the cap bite, and was the right email ever
  among those left out?
- **Selection**: how often was the right email found but not selected, because its headers
  named neither the vendor nor an invoice?
- **Matching's `CANDIDATE_DAYS_BEFORE`** (3), seen from retrieval's side: how many correct
  invoices were dated more than three days after the payment, and so never proposed it?

When a row says a number was wrong, change it **and cite the row**.

---

## How to run the bench

```
BENCH_WORKSPACE=<uuid> BENCH_USER=<owner user id> \
  npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts retrieval
```

It runs the real pipeline against the workspace and writes
`bench/out/retrieval/<vendor>-<id>/decision.txt`, which contains:

- the decision, with every settle term and the failing one marked;
- each mailbox searched, and its window and outcome;
- every email found, whether it was selected, and why;
- each document, and what matching made of it.

It writes to the database and to storage, because that is what retrieval does. Point it
only at a development workspace connected to a test mailbox.
