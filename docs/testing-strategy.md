# Testing Strategy

## Why this document exists

Most of this system's difficulty is in judgment: does this statement row mean the same
payment as that one, is this document the invoice for that transaction. Those questions
are not settled by unit tests, and pretending otherwise produces a green suite over a
product that gets the answers wrong.

So there are two kinds of verification here, and they are not interchangeable.

**Tests** check that deterministic code does what it should. They pass or fail.

**Evals** measure how well probabilistic behaviour performs against labelled examples.
They produce a score that moves, and the question is whether it moved down.

---

## Test layers

### Unit — the default

Pure functions, in isolation: statement parsing, balance validation, the canonical
transaction identity rule, vendor name normalization, amount and date comparison, state
transitions.

Most of the interesting logic in this system is a pure function over data. Keep it that
way — it is the reason the suite can stay fast.

### Integration — where the boundaries are

Backend, database, and workflow together: uploading a statement produces the right
canonical transactions; re-uploading produces none; resolving a requirement updates the
report.

Run against a real Postgres, not a mock. The invariants under test are database
constraints, and a mock cannot violate a constraint.

**Every workspace-scoped feature gets an isolation test**: two workspaces, and the second
one cannot see the first's data. Isolation is enforced in application code, so it is only
as good as the tests that try to break it.

### Golden file — for parsing

A parser is tested by running it over real statements and comparing against a checked-in
expected output.

This is the most valuable test asset in the repository. It is what makes it safe to change
a parser at all.

### End-to-end — sparingly

The one path that must never break: upload a statement, see transactions, see requirements,
resolve one, download the report. A handful of these, not a suite.

---

## Fixtures

```
fixtures/
  statements/       redacted real bank statements, by bank and format
  invoices/         redacted real invoices, including bad scans and photographs
  expected/         golden outputs, one per input
```

### Rules

**Fixtures are real, redacted.** Synthetic statements are uniformly well-formed, and
uniformly well-formed statements are exactly the ones parsers already handle. The value is
in the awkward ones.

This matters more under `docs/decisions/0003-llm-for-structure-not-values.md` than it did
before. Fixtures no longer pin down known formats for hand-written parsers — there are no
per-bank parsers. They exist to demonstrate that **column mapping generalizes across real
variety**. A fixture set of well-behaved statements proves nothing about the one property
the design depends on. Awkward statements are now the most valuable fixtures, not the ones
to get to later.

**Redaction is mandatory and manual.** Account numbers, names, addresses, and balances are
replaced before a file enters the repository. A real customer statement must never be
committed. If in doubt, do not commit it.

**A failing golden test is a finding, not an inconvenience.** Never regenerate an expected
output to make a test pass. Either the change is correct and the fixture is updated
deliberately, in its own commit, with the diff reviewed — or the change is wrong. Blind
regeneration is how a parser silently gets worse.

**Every bug donates a fixture.** A statement that parsed wrong becomes a permanent test
case.

---

## Evals

`docs/architecture.md §21` defers the OCR provider, the LLM, the reconciliation scoring,
and the confidence thresholds to evaluation. Without a harness, those get decided by
whichever output looked good in the moment.

### What needs one

| Question                          | Measure                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Does column mapping generalize? | Mapping accuracy on held-out real statements from banks not in the fixture set |
| Which OCR provider?               | Field-level extraction accuracy across clean PDFs, scans, and photographs |
| Which model for extraction?       | Field accuracy, schema-valid output rate, cost, latency                   |
| Which matching thresholds?        | Precision, recall, false-positive rate, how often the user is asked       |
| Does invoice identification work? | Agreement with labelled expectations                                      |

### The rule that matters

**A false positive costs more than asking the user.** Attaching an invoice to the wrong
transaction produces a wrong number in the accounts and nobody notices. Asking the user
costs ten seconds.

Tune the thresholds accordingly: optimize precision, accept a higher review rate, and
treat any increase in false positives as a regression even when the aggregate score
improved.

### Running them

Evals are not part of `npm test` — they cost money and time. They run deliberately, before
a provider, model, prompt, or threshold change is accepted, and the result is committed
next to the change so the comparison is reviewable.

---

## What is not tested

- Third-party APIs. Test the code around them; assume Gmail works.
- Exact LLM output. Test schema validation and the handling of bad output.
- Visual appearance.

## Conventions

- `vitest`. Tests live next to what they test, or in `tests/` for integration.
- Name a test for the behaviour, not the function: `merges identical rows from overlapping
statements`, not `test dedup`.
- A test that needs a comment to explain what it covers is testing too much.
- Reference the spec where it helps: `// spec: upload-statement §5a`.
