# AGENTS.md

## Project

Muneem Ji is an invoice-to-bank-transaction reconciliation tool for small business owners.

The MVP flow is:

1. Connect Gmail
2. Upload bank statement
3. Parse transactions
4. Identify transactions that may have invoices
5. Search Gmail for relevant invoices
6. Match invoices to transactions
7. Generate Excel
8. Report missing/unresolved invoices

## Specifications

Read before changing anything in the relevant area. These are the contract; the code
follows them, not the other way round.

| Document                     | Read it when                                           |
| ---------------------------- | ------------------------------------------------------ |
| `docs/glossary.md`           | Always. One concept, one name.                         |
| `docs/state-machines.md`     | Touching any state. Do not invent states.              |
| `docs/domain-model.md`       | Touching domain entities or invariants.                |
| `docs/architecture.md`       | Touching boundaries, storage, workflows, or AI usage.  |
| `docs/workflows/*.md`        | Implementing that workflow.                            |
| `docs/phases/*.md`           | Scoping a phase, or deciding what to build next.       |
| `docs/definition-of-done.md` | Before claiming a change is finished.                  |
| `docs/testing-strategy.md`   | Writing tests, fixtures, or evals.                     |
| `docs/decisions/`            | Making or revisiting a significant technical decision. |

If a change requires contradicting one of these, update the document in the same change or
say so. Do not let code and specification drift apart silently.

Items marked **OPEN DECISION** in the docs are genuinely unsettled. Surface them; do not
resolve them silently.

## Engineering Principles

### 1. Prefer simple systems

Do not introduce abstractions, frameworks, services, agents, or dependencies unless they solve a demonstrated problem.

Prefer the simplest implementation that satisfies the current requirement.

### 2. Deterministic before probabilistic

Use normal code when the problem can be solved reliably with normal code.

Use an LLM when reasoning, ambiguity, extraction, or semantic matching genuinely benefits from it.

Use an agentic workflow only when the system needs to choose actions, inspect results, and potentially retry or change strategy.

### 3. Small changes

Make one logical change at a time.

Do not modify unrelated files while implementing a feature.

Avoid large refactors unless explicitly requested.

### 4. Tests are part of implementation

New behaviour should have appropriate tests.

Do not remove or weaken tests to make implementation easier.

When fixing a bug, first reproduce it with a test when practical.

### 5. Preserve boundaries

Keep business logic separate from:

- UI
- database access
- external APIs
- LLM providers
- authentication

External dependencies should be replaceable where practical.

### 6. Do not guess

If requirements are ambiguous, identify the ambiguity instead of inventing behaviour.

Do not silently introduce product requirements.

### 7. Keep the repository clean

Do not create documentation, configuration, abstractions, utilities, or files without a clear purpose.

Delete obsolete code instead of leaving dead alternatives behind.

### 8. Git history matters

The history should read as the story of how this system came to be. Someone should be
able to follow it and understand not just what the code became, but why it went that way.

Each commit is one coherent change. Prefer small, reviewable commits.

**Format is enforced.** `commitlint` rejects anything that is not a conventional commit,
and the hook runs on every commit:

```
<type>(<optional scope>): <subject>

<body: why this change, what it replaces, what it trades away>
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`.

**The subject says what changed, not which files were touched.** `fix: prevent duplicate
transactions from overlapping statements`, never `fix: update parser.ts`.

**The body carries the why.** This is the part that makes history a story rather than a
list. For anything non-trivial, say what the problem was and why this approach — a diff
shows what changed and can never show what was rejected.

Reference a decision record (`docs/decisions/`) when the reasoning is larger than a commit
body.

**Do not mix kinds of change in one commit.** Formatting, refactoring, and behaviour
belong in separate commits. A behavioural change buried in a thousand lines of reformatting
is unreviewable, and that is how bugs get merged.

**Never rewrite pushed history.** No force pushes, no rebasing what others may have pulled.

### 9. Explain important decisions

When making a significant technical decision, record:

- the problem
- the options considered
- the decision
- why it was chosen

Do not create documentation for trivial decisions.

### 10. AI-assisted development

AI may propose and implement changes, but the developer remains responsible for understanding and approving them.

Before accepting a significant change:

- understand what it does
- understand why it is needed
- inspect the diff
- run the relevant tests
- verify that it respects the architecture

Never blindly accept generated code.

### 11. Work that depends on the human goes to Linear

Some work cannot be done by an agent: creating accounts, entering card details, granting
access, approving a policy, signing something, verifying a domain, deciding a name. That
work must never live only in a chat message — between sessions, chat is lost.

**Whenever a task turns out to depend on the developer, create a Linear issue for it
before continuing.** Team: `Bani Waraich`. The issue is the record; the chat message is
only a pointer to it.

Each issue must contain enough for the developer to act without re-reading the session:

- **Title** — the action, in the imperative ("Verify ledgerwick.com in Resend").
- **Why it is blocked on a human** — the specific reason an agent cannot do it (needs a
  login, a payment method, a legal decision, a physical document).
- **What it unblocks** — the code, spec section, or deploy that is waiting on it.
- **Step-by-step instructions** — the exact path: which service, which page, which values
  to enter, what the result should look like when it is done.
- **Definition of done** — the observable end state, so completion is not a judgement call.

**Set a priority on every such issue** so the order to tackle them in is explicit:

- **Urgent (1)** — blocking work right now, or has a real deadline (expiry, outage, legal).
- **High (2)** — blocks the current phase; the next piece of work stalls without it.
- **Medium (3)** — needed soon, but something else can proceed meanwhile.
- **Low (4)** — housekeeping; do it when there is slack.

**Follow up at the start of each session.** Before picking up new work, list the open
Linear issues assigned to the developer, ask which have been done, and close or update
them accordingly. Do not silently work around a blocked task — if it is still open, say so
and confirm what to do instead.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
