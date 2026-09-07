# Definition of Done

A change is done when every line below is true. Not "mostly", and not "the happy path
works".

This exists because the failure mode of AI-assisted development is not bad code — it is
work reported as finished that was never actually finished.

## Every change

- [ ] It does what was asked, and only what was asked.
- [ ] `npx tsc --noEmit` passes.
- [ ] `npm test` passes. Not "passes except one unrelated failure" — passes.
- [ ] New behaviour has tests. A bug fix has a test that fails without the fix.
- [ ] No test was deleted, skipped, or weakened to make it pass.
- [ ] No dependency was added without a stated reason.
- [ ] No file was created that nothing uses (`AGENTS.md §7`).
- [ ] Unrelated files are untouched (`AGENTS.md §3`).
- [ ] Anything left incomplete is stated plainly in the summary, not omitted.

## When it touches the domain

- [ ] It matches `docs/domain-model.md`, or that document was updated in the same change.
- [ ] Names match `docs/glossary.md`. No synonyms invented.
- [ ] States match `docs/state-machines.md`. No states invented.
- [ ] The invariants hold: at most one invoice per transaction, at most one transaction per
      invoice, at most one requirement per canonical transaction.

## When it touches workspace-scoped data

- [ ] Every query is scoped to a workspace. Every one.
- [ ] There is a test that attempts cross-workspace access and expects it to fail.
- [ ] No workspace identifier comes from the client without being checked against the
      session.

Isolation is enforced in application code (`docs/architecture.md §5.2`), which means a
single missing filter is a data leak. This section is not optional.

## When it touches documents or credentials

- [ ] Documents are served through an authorized route, never a public storage URL.
- [ ] No token or credential is logged, returned to the frontend, or sent to a model.
- [ ] An uploaded file is never deleted by automated processing.

## When it touches an LLM

- [ ] Output is validated against a schema before anything is persisted.
- [ ] Schema validation failure is handled, and does not crash the workflow.
- [ ] Nothing the model asserts becomes authoritative state without validation
      (`docs/architecture.md §2.3`).
- [ ] The prompt is in a versioned file, not an inline string.

## When it touches a background workflow

- [ ] Running it twice produces the same result as running it once.
- [ ] Recoverable and non-recoverable failures are distinguished.
- [ ] Failure is recorded as state, not swallowed.
- [ ] It does not stay suspended waiting on a human (`docs/architecture.md §12C`).

## Before saying it is done

- [ ] Read the diff.
- [ ] The summary says what was verified and how — not "should work".
- [ ] Anything skipped, assumed, or deferred is stated.
