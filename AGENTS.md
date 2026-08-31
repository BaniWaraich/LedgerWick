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

* UI
* database access
* external APIs
* LLM providers
* authentication

External dependencies should be replaceable where practical.

### 6. Do not guess

If requirements are ambiguous, identify the ambiguity instead of inventing behaviour.

Do not silently introduce product requirements.

### 7. Keep the repository clean

Do not create documentation, configuration, abstractions, utilities, or files without a clear purpose.

Delete obsolete code instead of leaving dead alternatives behind.

### 8. Git history matters

Each commit should represent one coherent change.

Commit messages should explain what changed, not what files were touched.

Prefer small, reviewable commits.

### 9. Explain important decisions

When making a significant technical decision, record:

* the problem
* the options considered
* the decision
* why it was chosen

Do not create documentation for trivial decisions.

### 10. AI-assisted development

AI may propose and implement changes, but the developer remains responsible for understanding and approving them.

Before accepting a significant change:

* understand what it does
* understand why it is needed
* inspect the diff
* run the relevant tests
* verify that it respects the architecture

Never blindly accept generated code.
