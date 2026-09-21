# 0010 — Invoice extraction returns what was printed, not what it means

Status: Accepted · 2026-09-21 · Extends `0003-llm-for-structure-not-values.md` and
`0009-mapping-returns-locators.md`

## Context

`0003` stakes this system's design on one line: **a model identifies structure, code reads
values.** It holds that line everywhere it can, and it is explicit about the one place it
cannot — a scanned statement, where there is no embedded text and therefore no deterministic
layer to put underneath. It names the cost plainly: "the model _is_ reading actual values
here. There is no deterministic layer underneath to catch a misread digit."

And then it supplies a guardrail anyway. A scanned statement still has to satisfy
`opening + credits − debits = closing`, and `§8` says a mismatch there goes to manual review
and is **never retried into acceptance**. The model reads values, and arithmetic the model
did not produce decides whether to believe it.

Feature F has no such arithmetic. An invoice is one page with one total on it. There is no
second figure to check the first against, no equation, no running balance, nothing internal
that disagrees when the reading is wrong. Every document reaching document understanding is
either a photograph or a text layer, and in both cases the vendor, the amount and the date
come from a model with nothing beneath it.

So F is structurally the case `0003` calls higher-risk, arriving without the compensating
check `0003` relied on. A wrong total does not announce itself. It becomes an `invoices` row,
it fails to match a transaction in feature G or — worse — matches the wrong one, and the
business owner reconciles their accounts against a number nobody read correctly.

`0003`'s own reasoning says why this is the dangerous shape: "A model asked 'which column is
the debit column' is answering a question with a small answer space, verifiable against the
rest of the file. A model asked 'what are all the amounts' is producing thousands of
unverifiable claims, any one of which can be wrong in a way nobody notices."

An invoice is a small number of unverifiable claims rather than thousands. That is better.
It is not different in kind.

## Options

**Trust the schema-validated output.** `generateObject` already refuses output that does not
fit, so a total comes back as a number of the right type. This is what the scanned-statement
path does, and it is the cheapest thing available. But schema validation checks shape, not
truth: `12000` and `120000` are equally valid numbers, and nothing distinguishes a correct
reading from a misplaced decimal point. The one check available would be checking nothing.

**Let feature G's matching be the check.** A wrong total will not match any transaction, so
the error surfaces as a failed match rather than as a wrong value. Appealing, and wrong in
two ways. It is silent about every field matching does not use — an invoice date wrong by a
month, a vendor attributed to the wrong company — and it converts a reading error into a
"we could not find this" outcome, which is exactly the confusion `retrieve-invoices.md §18`
and `§16` exist to prevent. It also makes F depend on G, when F is deliberately built first
and entry-agnostic.

**Have the model report the characters, and let code read them.** Chosen, and the same move
`0009` made one level up.

## Decision

**Every money and date field comes back as the text the document printed, and deterministic
code parses it.**

```
total: { text: "Rs. 1,20,000.00" }
        ↓ readAmount(text, currency, decimalSeparator)
totalMinor: 12000000n
```

The parsing functions are `readAmount` (`src/money/amounts.ts`) and `readDate`
(`src/statements/dates.ts`) — the same ones that read every bank statement in the system,
called with the currency and separators the model reported alongside.

A span that does not parse is **dropped and recorded**, never guessed at. The field becomes
null and the span is kept in `InvoiceFields.unparsed`, so a document that lost its total is
distinguishable from a document that never printed one.

## Why

**It separates two errors that look identical and are not.** A model that returns `120000`
for `1,20,000.00` has interpreted the grouping; a model that returns the characters has not.
Only the second can be checked. Making the model report what it saw turns an unverifiable
claim about a value into a verifiable claim about a reading.

**It keeps money in one place.** Lakh grouping, currency symbols, accountants' brackets and
Dr/Cr markers are understood by `readAmount` and nowhere else. An invoice read by a second
implementation of those rules would drift from the statements it is supposed to match, and
the drift would show up as a reconciliation failure rather than as a bug.

**It refuses garbage instead of cleaning it.** `readAmount` accepts only digits and
separators once symbols and spacing are gone, because it was once more permissive and turned
`1,87,4??.00` into a confident `1874.00` — a garbled transcription becoming a plausible
number, on exactly the path with nothing underneath it. An invoice extraction inherits that
refusal for free.

**It gives feature H something to show.** `phase-1.md §7 H` requires confidence to be
"presented as the evidence that produced it, never as a percentage". The span is that
evidence: a reviewer sees the characters the system read and the document beside it, and can
settle the question by looking.

### What is being traded away

**A round trip's worth of fidelity, and some model effort.** Reporting characters is a
slightly harder instruction to follow than reporting a number, and a model that paraphrases
a span rather than transcribing it produces something that parses to a wrong value with no
sign of trouble. The prompt says so in as many words; nothing enforces it.

**It does not check that the model looked at the right line.** This is the important
limitation and it must not be papered over. A model that confidently transcribes the
subtotal into `total`, or the delivery date into `invoiceDate`, produces a perfectly
parseable span and a wrong invoice. Locators catch misreadings. They do nothing about
mislocations.

That gap is not closed by a better prompt, and pretending otherwise is how feature D ended
up with 466 green tests over a parser dropping 71% of a statement. It is closed — to the
extent it can be — by measurement, which is what `docs/extraction-acceptance.md` is for and
why F carries an acceptance bar at all.

## Consequences

- The model output schema in `src/ai/prompts/read-invoice.v1.ts` carries `{ text }` objects
  for `total`, `tax`, `subtotal` and `invoiceDate`, never numbers or ISO dates.
- `src/documents/fields.ts` is the only thing that turns a span into a value, and it is pure,
  total, and never throws — every caller is a background workflow for which an unreadable
  field is an outcome to record, not an error to retry.
- A currency the system has no exponent for drops the amounts rather than assuming two
  decimal places, for the reason `src/money/currencies.ts` gives about the yen.
- An extraction that obtained no usable value is `UNREADABLE` rather than a partially filled
  invoice. `manual-invoice-upload.md §11`'s message — "We couldn't read the details from this
  document" — is about details, not about text.
- The eval in `docs/extraction-acceptance.md` measures **mislocation**, which this decision
  does not address, as well as field accuracy. A document whose fields all parsed and all
  came from the wrong lines is a failure in that log.
- If the corpus shows mislocation is the dominant error, that is a finding about this
  decision's limits and deserves a new record — a bounding box per field, or a second pass
  that checks a total against the line items — not a quiet change of prompt.
