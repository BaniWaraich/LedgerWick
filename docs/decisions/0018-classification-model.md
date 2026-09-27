# 0018 — Classification stays on Sonnet 5, and the cost is in its thinking

Status: Accepted · 2026-09-27 · Evaluates `docs/architecture.md §21.2` for the
`classify-transactions` prompt

## Context

The first production reconciliation, on one fixture statement, cost about $2 and never
finished. Most of that was waste the code has since removed: identification ran as one Inngest
step that Vercel killed at 300 seconds, and it re-judged every payment that needed no
document on every attempt. What remained open was whether classification itself was
simply too expensive on Sonnet 5, and whether a cheaper model would do.

`§21.2` leaves the model to evaluation. This is the first one, and it is small: one
statement, `bench/classify.bench.ts`, 85 transactions from `hdfc-bank`, in batches of 20 as
production sends them, with no Business Knowledge.

## Options

| Candidate                    | Time  | Input tokens | Output tokens | Needs a document | Questions | Batches failed |
| ---------------------------- | ----- | ------------ | ------------- | ---------------- | --------- | -------------- |
| Sonnet 5, provider default   | 310 s | 17,131       | 30,614        | 7                | 30        | 0 of 5         |
| Haiku 4.5, provider default  | 60 s  | 13,563       | 7,016         | 13               | 48        | 0 of 5         |
| Sonnet 5, `reasoning: low`   | 84 s  | 9,852        | 5,252         | 0                | 15        | 2 of 5         |
| Sonnet 5, `reasoning: none`  | 94 s  | —            | —             | —                | —         | 5 of 5         |

One Sonnet 5 call on 20 of these rows, inspected directly, used 8,135 output tokens. 6,596
of them were thinking and 1,539 were the answer.

## Decision

**Keep Sonnet 5 with its default reasoning for classification.** Do not switch to Haiku 4.5,
and do not lower the reasoning level yet.

## Why

- **Haiku 4.5 is not a substitute.** It judged 53 of the 85 transactions differently from
  Sonnet. It asked 48 questions to Sonnet's 30, which works against §7's "few questions, and
  fewer each time". It also called credit card bill payments and loan EMIs "needs a
  document", reasoning that each purchase on the card needs its receipt. It is five times
  faster, and the disagreement is still too large to ship on one statement's evidence.
- **The cost is Sonnet's thinking, not its answers.** About 80% of its output tokens are
  reasoning. That points to the cheaper fix: the same model, thinking less.
- **Thinking less breaks the schema.** Without reasoning, Sonnet returns rows with
  `needsDocument: true` and `confident: false` together. `classify-transactions.v1` rejects
  that combination in a `superRefine`, and a rejection fails the whole batch of 20. At
  `low`, two batches in five failed; at `none`, all five. The combination is already
  harmless in code: `src/requirements/identify.ts` turns any unsure row into a question and
  never into a requirement. So the schema throws away nineteen good answers to catch one
  that the code would have handled anyway.

## Consequences

- `PromptDefinition` gains an optional `reasoning` level, passed to the model. Nothing sets
  it yet. The bench uses it (`anthropic/claude-sonnet-5@low`), and so will the next step.
- **Next:** a `classify-transactions.v2` that accepts `needsDocument` with `confident: false`
  and leaves the rule to `identify.ts`, then this bench again at `low` and `none`. If the
  answers hold, the cost of classification drops by roughly the share that is thinking.
- Batches of 20 cost something here. Sonnet asked about the same UPI payer in more than one
  batch, because "ask once per vendor" only holds within one list. Smaller batches mean
  more lists. Sending a batch the questions already raised in its run would close that.
- One statement, with no Business Knowledge, is thin evidence. The bench runs over every
  statement the parse bench has walked, so later evaluations should use more than one.
