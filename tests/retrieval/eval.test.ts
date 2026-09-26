/**
 * The retrieval policy, measured against a labelled set of messy mailboxes.
 *
 * spec: docs/testing-strategy.md "Evals" · docs/workflows/retrieve-invoices.md
 * decision: docs/decisions/0016-retrieval-proposes-settle-decides.md
 * log: docs/retrieval-acceptance.md
 *
 * ## What this measures, and what it cannot
 *
 * Every case runs the whole pipeline -- search, select, fetch, understand, match, settle --
 * against a scripted mailbox, with a scripted reader and **a model that agrees with every
 * proposal it is shown**. That is the worst adjudicator the policy could have. Zero false
 * positives under it means the deterministic terms alone refuse every wrong link in the
 * set, whatever a real model says.
 *
 * What it cannot measure is the real reader and the real adjudicator: whether a real
 * receipt is read correctly, whether a real model vetoes what it should. That is model
 * quality, and it waits for the gateway to have credit (`BAN-149`), for the bench, and for
 * rows in `docs/retrieval-acceptance.md`.
 *
 * ## Why the cases are messy on purpose
 *
 * `testing-strategy.md`: clean fixtures prove nothing about the property the design depends
 * on. These are the shapes that make retrieval hard: an alias the bank printed, an invoice
 * forwarded from a colleague under a generic name, Indian digit grouping, a vendor's
 * newsletter, the same PDF sent twice, two invoices for one payment, an invoice for last
 * month's charge that arrived inside this month's window.
 *
 * Headers and scripted readings are synthetic. No customer mail is in this repository.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import {
  invoiceRequirements,
  supportingDocuments,
  vendorAliases,
  vendors,
} from "../../src/db/schema";
import type { AdjudicateMatch } from "../../src/matching/contracts";
import { createTestDb, type TestDb } from "../helpers/db";
import { FakeGmail, type FakeMessage } from "../gmail/fake-gmail";
import { paper, Pipeline, reading, type Paper } from "./pipeline";
import { addWorkspace, type World } from "./world";

vi.mock("server-only", () => ({}));

const { markNeedsReauth } = await import("../../src/gmail/connections");

type Label = "AUTO" | "REVIEW" | "NOT_FOUND" | "BLOCKED";

interface Case {
  readonly name: string;
  readonly label: Label;
  /** For AUTO: the paper that must be the one linked. */
  readonly correct?: string;
  readonly transaction?: Parameters<World["transaction"]>[0];
  readonly vendorGuess?: string | null;
  readonly mailboxes: readonly { readonly messages: FakeMessage[]; readonly reauth?: boolean }[];
  readonly papers: readonly Paper[];
  readonly setup?: (w: World) => Promise<void>;
  readonly adjudicate?: AdjudicateMatch;
}

/** A message whose attachments are these papers. */
function message(
  id: string,
  papers: readonly Paper[],
  over: Partial<FakeMessage> = {},
): FakeMessage {
  return {
    id,
    from: '"Anthropic, PBC" <invoice+statements@mail.anthropic.com>',
    subject: `Your receipt from Anthropic, PBC #${id}`,
    receivedAt: "2026-04-14T08:30:00Z",
    rfc822MessageId: `<${id}@mail.example>`,
    attachments: papers.map((p) => ({ filename: `Receipt-${p.key}.pdf`, bytes: p.bytes })),
    ...over,
  };
}

const receipt = paper("receipt");
const notice = paper("tos", "NOT_AN_INVOICE");

const abc = reading({
  vendor: { legalName: "ABC Foods Private Limited", tradeName: "ABC Foods", aliases: [] },
  invoiceNumber: "ABC/24-25/0917",
  currency: "INR",
  total: { text: "1,20,000.00" },
});

const inrPayment = {
  amountMinor: 12_000_000n,
  currency: "INR",
  description: "UPI/402193384/ABCFOODS/PAYMENT",
  descriptionNormalized: "upi 402193384 abcfoods payment",
};

const disagrees: AdjudicateMatch = async () => ({
  ok: true,
  value: { candidate: null, verdict: "DIFFERENT", reason: "Different service." },
});

const acme = paper(
  "acme",
  reading({
    vendor: { legalName: "Acme Consulting LLP", tradeName: null, aliases: [] },
    invoiceNumber: "INV-77",
  }),
);

const CASES: Case[] = [
  {
    name: "a plain receipt, the same day",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [{ messages: [message("m1", [receipt])] }],
    papers: [receipt],
  },
  {
    name: "the bank printed an alias the user confirmed, and identification guessed nobody",
    label: "AUTO",
    correct: "receipt",
    vendorGuess: null,
    transaction: {
      description: "CLAUDE.AI SUBSCRIPTION",
      descriptionNormalized: "claude ai subscription",
    },
    setup: async (w) => {
      const [vendor] = await w.h.db
        .insert(vendors)
        .values({ workspaceId: w.scope.workspaceId, name: "Anthropic" })
        .returning();
      await w.h.db.insert(vendorAliases).values([
        {
          workspaceId: w.scope.workspaceId,
          vendorId: vendor.id,
          alias: "anthropic",
          aliasNormalized: "anthropic",
        },
        {
          workspaceId: w.scope.workspaceId,
          vendorId: vendor.id,
          alias: "claudeai",
          aliasNormalized: "claudeai",
          confirmed: true,
        },
      ]);
    },
    mailboxes: [{ messages: [message("m1", [receipt])] }],
    papers: [receipt],
  },
  {
    name: "forwarded by a colleague under a generic filename",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [
      {
        messages: [
          message("m1", [], {
            from: "Priya <owner@business.in>",
            subject: "Fwd: invoice",
            attachments: [{ filename: "Receipt-receipt.pdf", bytes: receipt.bytes }],
          }),
        ],
      },
    ],
    papers: [receipt],
  },
  {
    name: "Indian digit grouping, a UPI narration, a vendor's own domain",
    label: "AUTO",
    correct: "abc",
    vendorGuess: "ABC Foods",
    transaction: inrPayment,
    mailboxes: [
      {
        messages: [
          message("m1", [paper("abc", abc)], {
            from: "ABC Foods Accounts <billing@abcfoods.in>",
            subject: "Tax Invoice ABC/24-25/0917",
          }),
        ],
      },
    ],
    papers: [paper("abc", abc)],
  },
  {
    name: "the invoice was emailed six days after the payment",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [{ messages: [message("m1", [receipt], { receivedAt: "2026-04-20T11:00:00Z" })] }],
    papers: [receipt],
  },
  {
    name: "one email, an invoice beside terms of service and a logo",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [
      {
        messages: [
          message("m1", [receipt, notice], {
            attachments: [
              { filename: "Receipt-receipt.pdf", bytes: receipt.bytes },
              { filename: "Receipt-tos.pdf", bytes: notice.bytes },
              {
                filename: "logo.png",
                bytes: new Uint8Array([137, 80, 78, 71]),
                mimeType: "image/png",
              },
            ],
          }),
        ],
      },
    ],
    papers: [receipt, notice],
  },
  {
    name: "the same PDF sent twice",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [
      {
        messages: [
          message("m1", [receipt]),
          message("m2", [receipt], {
            receivedAt: "2026-04-16T08:30:00Z",
            subject: "Reminder: your receipt",
          }),
        ],
      },
    ],
    papers: [receipt],
  },
  {
    name: "the same mail in two connected mailboxes",
    label: "AUTO",
    correct: "receipt",
    mailboxes: [
      { messages: [message("m1", [receipt])] },
      { messages: [message("m1-b", [receipt], { rfc822MessageId: "<m1@mail.example>" })] },
    ],
    papers: [receipt],
  },
  {
    name: "two invoices from the vendor, same amount, same day",
    label: "REVIEW",
    mailboxes: [
      {
        messages: [
          message("m1", [paper("seat", reading({ invoiceNumber: "2231-9912" }))]),
          message("m2", [paper("usage", reading({ invoiceNumber: "2231-9913" }))]),
        ],
      },
    ],
    papers: [
      paper("seat", reading({ invoiceNumber: "2231-9912" })),
      paper("usage", reading({ invoiceNumber: "2231-9913" })),
    ],
  },
  {
    name: "the amount includes tax the bank did not",
    label: "REVIEW",
    mailboxes: [
      { messages: [message("m1", [paper("tax", reading({ total: { text: "23.60" } }))])] },
    ],
    papers: [paper("tax", reading({ total: { text: "23.60" } }))],
  },
  {
    name: "a dollar invoice against a rupee payment",
    label: "REVIEW",
    transaction: {
      amountMinor: 170_000n,
      currency: "INR",
      description: "ANTHROPIC SAN FRANCISCO",
      descriptionNormalized: "anthropic san francisco",
    },
    mailboxes: [{ messages: [message("m1", [receipt])] }],
    papers: [receipt],
  },
  {
    name: "the invoice is dated six days before the charge",
    label: "REVIEW",
    mailboxes: [
      {
        messages: [
          message("m1", [paper("early", reading({ invoiceDate: { text: "08/04/2026" } }))]),
        ],
      },
    ],
    papers: [paper("early", reading({ invoiceDate: { text: "08/04/2026" } }))],
  },
  {
    name: "a vendor we have never seen, the amount right and nothing else",
    label: "REVIEW",
    vendorGuess: null,
    transaction: { description: "NEFT 88412 XYZ", descriptionNormalized: "neft 88412 xyz" },
    mailboxes: [
      {
        messages: [
          message("m1", [acme], {
            from: "billing@acmeconsult.io",
            subject: "Invoice INV-77 for March services",
          }),
        ],
      },
    ],
    papers: [acme],
  },
  {
    name: "a scan nobody could read",
    label: "REVIEW",
    mailboxes: [{ messages: [message("m1", [paper("scan", "UNREADABLE")])] }],
    papers: [paper("scan", "UNREADABLE")],
  },
  {
    name: "a model that sees a different service",
    label: "REVIEW",
    adjudicate: disagrees,
    mailboxes: [{ messages: [message("m1", [receipt])] }],
    papers: [receipt],
  },
  {
    name: "the vendor's newsletter, with a PDF",
    label: "NOT_FOUND",
    mailboxes: [
      {
        messages: [
          message("m1", [notice], {
            from: "Anthropic <news@anthropic.com>",
            subject: "Anthropic: updates to our terms",
          }),
        ],
      },
    ],
    papers: [notice],
  },
  {
    name: "the vendor's receipt is the email body, with no attachment",
    label: "NOT_FOUND",
    mailboxes: [{ messages: [message("m1", [])] }],
    papers: [],
  },
  {
    name: "last month's invoice, arriving inside this month's window",
    label: "NOT_FOUND",
    mailboxes: [
      {
        messages: [
          message("m1", [paper("march", reading({ invoiceDate: { text: "14/03/2026" } }))], {
            receivedAt: "2026-04-08T09:00:00Z",
          }),
        ],
      },
    ],
    papers: [paper("march", reading({ invoiceDate: { text: "14/03/2026" } }))],
  },
  {
    // The false positive the design exists to prevent: an invoice for an identical
    // charge on another day, found in this charge's window.
    name: "an identical charge two weeks earlier owns the invoice that was found",
    label: "NOT_FOUND",
    setup: async (w) => {
      await w.transaction({ valueDate: "2026-04-01" });
    },
    mailboxes: [
      {
        messages: [
          message("m1", [paper("april1", reading({ invoiceDate: { text: "01/04/2026" } }))], {
            receivedAt: "2026-04-08T09:00:00Z",
          }),
        ],
      },
    ],
    papers: [paper("april1", reading({ invoiceDate: { text: "01/04/2026" } }))],
  },
  {
    name: "an empty mailbox",
    label: "NOT_FOUND",
    mailboxes: [{ messages: [] }],
    papers: [],
  },
  {
    name: "the only mailbox needs reconnecting",
    label: "BLOCKED",
    mailboxes: [{ messages: [message("m1", [receipt])], reauth: true }],
    papers: [receipt],
  },
];

interface Result {
  readonly name: string;
  readonly label: Label;
  readonly outcome: Label;
  /** For an automatic link: the paper that was linked. */
  readonly linked: string | null;
  readonly correct?: string;
}

function outcomeOf(state: string): Label {
  switch (state) {
    case "RESOLVED":
      return "AUTO";
    case "NEEDS_REVIEW":
      return "REVIEW";
    case "BLOCKED":
      return "BLOCKED";
    default:
      return "NOT_FOUND";
  }
}

/*
 * One database for the whole set, and a fresh workspace per case. Twenty-one databases
 * was slow enough under the full suite to time out, and workspaces are the isolation the
 * product itself relies on -- which `isolation.test.ts` proves separately.
 */
let h: TestDb;

async function runCase(c: Case): Promise<Result> {
  const w = await addWorkspace(h, new FakeGmail());
  {
    await c.setup?.(w);
    for (const [index, mailbox] of c.mailboxes.entries()) {
      const refresh = `r-${index}`;
      const id = await w.connect(refresh);
      w.gmail.mailbox(refresh, mailbox.messages);
      if (mailbox.reauth) await markNeedsReauth(w.scope, id);
    }
    const requirementId = await w.requirement(
      await w.transaction(c.transaction ?? {}),
      c.vendorGuess === undefined ? {} : { vendorGuess: c.vendorGuess },
    );

    await new Pipeline(w, c.adjudicate).know(...c.papers).run(requirementId);

    const [row] = await w.h.db
      .select()
      .from(invoiceRequirements)
      .where(eq(invoiceRequirements.id, requirementId));
    let linked: string | null = null;
    if (row.resolvedDocumentId) {
      const [document] = await w.h.db
        .select()
        .from(supportingDocuments)
        .where(eq(supportingDocuments.id, row.resolvedDocumentId));
      linked = /^Receipt-(.+)\.pdf$/.exec(document.filename)?.[1] ?? document.filename;
    }

    return {
      name: c.name,
      label: c.label,
      outcome: outcomeOf(row.state),
      linked,
      correct: c.correct,
    };
  }
}

const results: Result[] = [];

beforeAll(async () => {
  h = await createTestDb();
  for (const c of CASES) results.push(await runCase(c));
}, 300_000);

afterAll(async () => {
  await h.close();

  const autos = results.filter((r) => r.outcome === "AUTO");
  const truePositives = autos.filter((r) => r.label === "AUTO" && r.linked === r.correct);
  const expectedAutos = results.filter((r) => r.label === "AUTO");
  const ratio = (n: number, d: number) => (d === 0 ? "n/a" : (n / d).toFixed(2));

  // A summary for whoever runs this, in the shape docs/retrieval-acceptance.md records.
  console.info(
    [
      "",
      "retrieval policy — scripted reader, always-agreeing adjudicator",
      `  cases                        ${results.length}`,
      `  automatic-link precision     ${ratio(truePositives.length, autos.length)}`,
      `  automatic-link recall        ${ratio(truePositives.length, expectedAutos.length)}`,
      `  false positives              ${autos.length - truePositives.length}`,
      `  false negatives              ${expectedAutos.length - truePositives.length}`,
      `  review rate                  ${ratio(results.filter((r) => r.outcome === "REVIEW").length, results.length)}`,
      `  not-found rate               ${ratio(results.filter((r) => r.outcome === "NOT_FOUND").length, results.length)}`,
      "",
    ].join("\n"),
  );
});

describe("the retrieval policy on labelled mailboxes", () => {
  it("makes no false-positive automatic link, even with a model that agrees with everything", () => {
    // testing-strategy.md: a false positive costs more than asking the user.
    const wrong = results.filter(
      (r) => r.outcome === "AUTO" && (r.label !== "AUTO" || r.linked !== r.correct),
    );
    expect(wrong).toEqual([]);
  });

  it.each(CASES.map((c) => [c.name, c.label] as const))("%s → %s", (name, label) => {
    const result = results.find((r) => r.name === name);
    expect(result?.outcome).toBe(label);
  });
});
