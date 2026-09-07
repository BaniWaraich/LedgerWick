# Connect Gmail

## 1. Actor

**Business Owner**

---

## 2. Goal

Allow a Workspace to authorize one or more Gmail accounts so that Muneem Ji can search
them for supporting documents, and keep that authorization healthy over time.

This workflow owns everything about the Gmail _connection_. It does not search, retrieve,
or match anything; that is `retrieve-invoices.md`.

---

## 3. Entry points

### A. Onboarding

The user is prompted to connect a Google account when setting up a Workspace.

Connecting is **skippable**. A business owner who declines can still upload statements and
upload invoices manually; they simply get no automatic retrieval. Retrieval is a
convenience, not a precondition for the product working.

### B. Workspace settings

An account may be connected, listed, or disconnected at any time.

### C. Reauthorization prompt

When a connection stops working, the user is directed here from wherever they encountered
the problem — most often the Missing Invoice Report.

---

## 4. Multiple accounts

A Workspace may connect several Gmail accounts, because invoices routinely arrive at
different addresses:

```text
Workspace
├── accounts@company.com
├── founder@gmail.com
└── finance@company.com
```

Each connection is independent: one may be healthy while another needs reauthorization.

The same Gmail address may be connected to more than one Workspace belonging to the same
user. Each such connection is a separate record with separate credentials, and searching
one Workspace never reads another Workspace's connection.

---

## 5. Authorization

The user is sent through Google's OAuth consent flow and returns with credentials that
Muneem Ji stores.

### Scope

Request **read-only** access to mail, and nothing more.

Muneem Ji never sends, modifies, deletes, or labels mail. Requesting no more than
read-only access is a product commitment, not only a technical one: the user is being asked
to expose their business correspondence, and the narrowest possible scope is the honest
request.

### The scope tier is not negotiable

`gmail.readonly` is a **Restricted** scope. So is `gmail.metadata`. Both require Google's
CASA security assessment before an app may use them in production with unrestricted users.

There is therefore no cheaper scope that still does the job. Retrieval must fetch attachment
bytes, and only `gmail.readonly` or broader exposes them — `gmail.metadata` returns headers
only. Any design that reads a customer's mailbox through the Gmail API pays the assessment.

Treat CASA as a fixed cost of the Gmail path, not as a variable to design around.

Note also that `readonly` is a superset of `metadata`. Requesting both grants `readonly`;
the token can read message bodies whatever else is asked for alongside it.

### Limiting what our code sees

Since the scope cannot be narrowed, the narrowing has to happen in our own code.

Retrieval calls `format=METADATA` — headers only — for search and candidate evaluation, and
requests full message content **only** to fetch an attachment on a message that has already
been selected as a candidate.

This is a self-imposed discipline. Google does not enforce it and the user cannot observe
it, so it is worth nothing unless it is enforced here:

- Gmail access goes through one module, and that module is the only place a full-format
  fetch may be made.
- Message bodies are never persisted and never sent to an LLM. Candidate evaluation
  operates on headers, attachment filenames, and the attachment itself.
- A test asserts that the search path issues no full-format request.

The benefit is blast radius, not compliance: a bug or a compromise in retrieval exposes
headers rather than the full text of a business's correspondence. That is worth having on
its own terms — but it is not a substitute for the assessment, and must not be described as
one.

**OPEN DECISION** — whether to use the Gmail API at all.

_Option A — Gmail API with OAuth (assumed by this document)._ Reads existing mail, including
everything already in the mailbox. Requires CASA: a third-party audit, a real cost, and
weeks of lead time. Standard, recognizable consent flow.

_Option B — auto-forwarding to an address Muneem Ji controls._ The user sets a Gmail filter
forwarding invoice-like mail to a per-workspace address; we ingest by SMTP/webhook. No
OAuth, no Restricted scope, no CASA.

Option B looks cheaper and probably is not, for one reason that may be decisive:
**forwarding is prospective.** It cannot see mail that already exists. The product's primary
flow is uploading past statements and finding the documents for them, which is retroactive
by definition — so Option B cannot serve it at all, only the steady state afterwards.

It also changes what we are: holding a mailbox rather than reading one, which replaces the
assessment with an inbound-mail security burden of our own (spoofing, unsolicited mail,
retention of content nobody reviewed) and a fragile setup step the user performs inside
Gmail and can silently break.

The recommendation is **Option A**, accepting CASA as a cost of the product, with Option B
reconsidered only as a later addition for users who refuse OAuth.

This must be settled before launch. It does not block development, which proceeds against a
test account under an unverified app.

### What the user is told

Before the consent screen, state plainly:

- which Workspace the account is being connected to,
- that Muneem Ji reads mail only to find invoices and receipts,
- that it never sends or changes mail,
- that they can disconnect at any time.

---

## 6. Credential storage

Refresh and access tokens are secrets of the highest sensitivity in this system: they grant
standing read access to a business's mail.

Requirements:

- Tokens are encrypted at rest and never stored in plaintext.
- Tokens are never logged, never included in error reports, and never sent to an LLM.
- Tokens are never exposed to the frontend, in any form, for any reason.
- Every read of a token is scoped to a single Workspace connection.
- Disconnecting deletes the stored credentials and revokes them with Google.

See `docs/architecture.md §12.4` and `§19`.

---

## 7. Connection states

| State          | Meaning                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `CONNECTED`    | Authorization is valid and retrieval may use this account.                                     |
| `NEEDS_REAUTH` | The grant expired or was revoked. Retrieval cannot use this account until the user reconnects. |
| `DISCONNECTED` | The user removed the connection. Credentials deleted.                                          |

`NEEDS_REAUTH` is a user-action state, not a failure. Nothing is wrong on Muneem Ji's
side, and retrying will not fix it.

Retrieval must not repeatedly attempt an account in `NEEDS_REAUTH`; it marks the affected
Invoice Requirements `BLOCKED` (`docs/state-machines.md §2`) and stops.

---

## 8. Detecting a broken connection

A connection becomes `NEEDS_REAUTH` when Google reports the grant is invalid — the user
revoked access, changed their password, or the refresh token expired.

This must be distinguished from a transient Gmail failure. Rate limiting, timeouts, and
5xx responses are recoverable and are retried; they never mark a connection broken. See
`retrieve-invoices.md §18`.

---

## 9. Reauthorization

The user is told which specific account needs attention and what it is currently costing
them:

```text
We can't reach founder@gmail.com

Google needs you to reconnect this account.
Until then we can't search it for invoices.

7 invoices are waiting on this.

[Reconnect]
```

Reconnecting restores the existing connection rather than creating a second one, so the
history of documents already retrieved from that account stays intact.

Requirements that were `BLOCKED` on this account become eligible for retrieval again.

---

## 10. Disconnecting

The user may disconnect an account at any time.

On disconnect:

- stored credentials are deleted and revoked with Google,
- **documents already retrieved from that account are kept.**

The second point matters. A retrieved invoice is now part of the business's financial
records, and those records must not evaporate because a mailbox was disconnected. The
document's provenance still records where it came from.

The user is told this before confirming.

---

## 11. Output

Per connection:

- Workspace
- Google account email
- Connection state
- Granted scopes
- When it was connected
- When it was last used successfully
- Encrypted credentials

---

## 12. Implementation boundary

Gmail specifics stay behind the invoice-source boundary described in
`docs/architecture.md §12.3`. The rest of the system asks for "the connected sources of a
Workspace" and never for "the Gmail accounts".
