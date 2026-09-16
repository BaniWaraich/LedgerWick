# Fixtures

Real, redacted source documents and their golden outputs. Layout and rules are set by
`docs/testing-strategy.md §Fixtures`; this file is the working copy of them.

```
fixtures/
  statements/       redacted real bank statements, by bank and format
    inbox/          UNREDACTED drop zone — git-ignored, never committed
  invoices/         redacted real invoices, including bad scans and photographs
  expected/         golden outputs, one per input
```

## Dropping new statements (BAN-136)

Put them in `fixtures/statements/inbox/` — flat, any filename, **as they came off the
bank**. Do not redact them first.

**The inbox is git-ignored and never committed.** It is a staging area on one machine,
holding documents that still have real account numbers, names and balances in them. A
file leaves the inbox only by being redacted and moved up into `statements/`, which is
tracked. Redaction happens on the way out, not on the way in.

Helpful but not required in the filename: bank, format, period —
e.g. `hdfc-savings-2026-03-text-pdf.pdf`, `icici-2026-q1.csv`.

## Rules

- **Redaction is mandatory and manual.** Account numbers, names, addresses and balances
  are replaced before a file moves out of `inbox/` into a tracked directory. A real
  customer statement must never be committed. If in doubt, do not commit it.
- **Do not tidy the structure.** Wrapped descriptions, repeated headers, mid-table
  footers, split debit/credit columns, mixed date formats — those are the point, not
  defects to clean up.
- **Never regenerate an expected output to make a test pass.** A failing golden test is
  a finding.
- **Every bug donates a fixture.**
