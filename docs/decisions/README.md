# Decision Records

`AGENTS.md §9` requires that significant technical decisions be recorded. This is where
they live.

One file per decision, named `NNNN-short-slug.md`, numbered sequentially. Each records:

- **Context** — the problem, and what forced the decision now
- **Options** — what was genuinely considered
- **Decision** — what was chosen
- **Why** — including what is being traded away
- **Consequences** — what this now obliges or forbids

Rules:

- A decision record is never edited to change its decision. Superseding it means writing a
  new record and marking the old one `Superseded by NNNN`.
- Trivial decisions do not get a record. If the answer is obvious to the next reader from
  the code, it is trivial.
- If you find yourself explaining the same choice twice, write the record.
