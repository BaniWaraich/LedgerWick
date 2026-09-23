# When matching is done

## Why this document exists

The third of these, and the pattern is now deliberate. `docs/parsing-acceptance.md` was
written after the fact, when 466 passing tests sat alongside a parser dropping 71% of a
real statement. `docs/extraction-acceptance.md` was written before the fact, for the same
reason and a stronger one. This one is written before the fact and for the strongest reason
of the three.

Parsing has the balance equation: read a statement wrong enough and
`opening + credits − debits = closing` stops working. Weak, but real, and automatic.

Extraction has nothing — one page, one total, no second figure to check the first against.
`docs/decisions/0010` says what that costs: "Locators catch misreadings. They do nothing
about mislocations."

**Matching has less than nothing.** A wrong link does not merely lack a check; it satisfies
every check there is. The invoice is linked. The requirement is `RESOLVED`. The one-to-one
invariant holds. The Missing Invoice Report's three numbers still sum to the denominator.
The Excel export renders a row with a document beside it. Every constraint in the database
is content, and the reconciliation is wrong.

And it is wrong in the way that does the most damage, because it looks finished. An invoice
that matched nothing sits in a queue asking to be dealt with. An invoice on the wrong
payment is silent. The only person who can catch it is the accountant reading a
reconciliation they were told was complete — and they will not check the ones that look
done.

So the evidence for feature G is a log kept by a human, and this document is that log.

---

## The measurement that matters

**First-attempt correctness on unseen invoices, with false positives counted separately.**

`docs/testing-strategy.md` sets the rule this document is built around:

> A false positive costs more than asking the user … optimize precision, accept a higher
> review rate, and treat any increase in false positives as a regression even when the
> aggregate score improved.

That last clause is why the columns below are not summed into a score. A change that
matched four more invoices correctly and one more incorrectly is a **regression**, and any
single number would report it as an improvement.

### A document gets one first impression

The rule the other two logs share, and it is no weaker here.

**Run a new invoice blind, record the outcome, and only then fix anything.** An invoice
consumed as a bug report becomes training data: the code has since been shaped by it, so
from then on it can only show we have not regressed, never that we generalise.

---

## What each outcome means

Matching has three outcomes and they are not equally good. Read the table as a ranking.

| Outcome | What it means | Cost |
| --- | --- | --- |
| **Correct link** | Linked automatically, to the right payment. | None. This is the product working. |
| **Correct review** | Sent to the user, and the user's answer was not obvious from the evidence. | The user's attention, briefly. Acceptable. |
| **Unnecessary review** | Sent to the user, and the right answer was plainly there. | The user's attention, wasted. Annoying, and it erodes trust in the queue. |
| **Missed match** | Reported as no reliable match when a correct payment was present. | The user does the work the product exists to do. |
| **False positive** | Linked automatically, to the wrong payment. | **Wrong accounts, silently.** The failure this design exists to prevent. |

One false positive outweighs several unnecessary reviews. That asymmetry is built into
`src/matching/thresholds.ts` and it has to survive contact with the numbers below.

---

## What "passed" means for one invoice

An invoice passes only if **all** of:

- **The outcome is correct.** The right payment was linked, or the user was genuinely
  needed. A correct link for the wrong reason is not a pass — check the evidence that
  carried it, not just the result.
- **No false positive**, for this invoice or any other affected by the run.
- **The evidence shown is true.** Every sentence on the candidate is checkable against the
  document and the statement. "Amount matches exactly" had better be exact.
- **The duplicate judgment is right.** Not flagged when it is a new charge; flagged when
  it is a second copy.
- **Re-running produces nothing new.** No second invoice, no second candidate set, no
  second requirement write.

---

## The bar

**Six consecutive unseen invoices matched correctly on first attempt, with no code change
between them, and zero false positives across the whole log.**

The second clause is stricter than the streak and does not reset with it. A false positive
at any point is a finding about the design, not a bad document — it means the conjunction
in `decide.ts` has a term that does not hold, and the response is to find that term, not to
wait for six clean runs afterwards.

Current streak: **0**. First-attempt outcomes: **0 of 0**. False positives: **0 of 0**.

This gates **Phase 1**, not feature G. `docs/phases/phase-1.md §7 G` carries the same split
features D and F carry: the functional bar — the pipeline runs, the invariants hold, the
policy is exercised — is met inside G. The quality bar is earned across the rest of the
phase. `BAN-149` (credits) and `BAN-150` (the invoice corpus) are what it is waiting on.

---

## The log

One row per invoice, written **before** anything is fixed.

| # | Invoice | Outcome | Correct? | Blocked by | What it taught |
| - | ------- | ------- | -------- | ---------- | -------------- |
| _(none yet — the gateway has no credit, `BAN-149`)_ |

`Blocked by` is the term from `decide.ts` that stopped an automatic link, which the bench
prints. It is the most useful column in the table: an invoice that should have matched and
went to review names its own cause, and a term that appears over and over is the one to
measure first.

---

## The thresholds this replaces

Every number in `src/matching/thresholds.ts` is a placeholder. `docs/architecture.md §21.4`
forbids choosing them by intuition, and they were, because nothing else was available. Each
carries a comment saying what would have to be measured to move it.

When a row in the log above says a threshold was wrong, change it **and record which row
caused the change**. A threshold moved without a row behind it is intuition wearing
evidence's clothes, which is the thing `§21.3` and `§21.4` exist to prevent.

### The questions the corpus has to answer

- **`CANDIDATE_DAYS_AFTER`** — how many real matches settled outside ten days?
- **`AUTO_MATCH_AMOUNT_TOLERANCE_MINOR`** — how often is a near-miss a true match, and what
  does the same tolerance cost in false positives? `§21.3` asks for precision, recall and
  false-positive rate specifically.
- **`AUTO_MATCH_DATE_DAYS`** — of the correct links, how far out was the furthest?
- **`DUPLICATE_MIN_AGREEING_FIELDS`** — how many duplicate questions were unnecessary, and
  how many second invoices got through?

---

## How to run it

The bench is a microscope, not a test. It asserts nothing; a red run means the harness
broke.

```
BENCH_WORKSPACE=<workspace uuid> \
  npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
```

It writes `bench/out/matching/<invoice>/decision.txt` — the invoice, the decision, every
term of the conjunction with the failing one marked, the model's verdict, and each
candidate with its evidence as sentences. Read that beside the document and the statement.

`BENCH_REJUDGE=1` asks the model again instead of using the cached answer.
`bench/out/matching/<invoice>/adjudication.json` can be **edited by hand**, which is how to
ask "did the model choose wrongly, or did the policy weigh it wrongly?" without changing a
line of code.
