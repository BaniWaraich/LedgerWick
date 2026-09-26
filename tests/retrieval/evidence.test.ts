/**
 * What a message's headers establish, and how they are chosen for download.
 *
 * spec: docs/workflows/retrieve-invoices.md §9 · docs/workflows/invoice-match-review.md §5
 */

import { describe, expect, it } from "vitest";

import {
  describeAllEmail,
  emailEvidenceFor,
  hasSignal,
  parseFrom,
  type EmailEvidence,
} from "../../src/retrieval/evidence";
import { selectForFetching } from "../../src/retrieval/select";
import { MAX_MESSAGES_FETCHED } from "../../src/retrieval/thresholds";

const context = {
  vendorKeys: ["anthropic", "claudeai"],
  transactionDate: "2026-04-14",
  mailboxAddress: "accounts@business.in",
};

function evidence(from: string, subject: string, receivedAt = "2026-04-14T10:00:00Z") {
  return emailEvidenceFor({ from, subject, receivedAt: new Date(receivedAt) }, context);
}

function find<K extends EmailEvidence["kind"]>(items: EmailEvidence[], kind: K) {
  return items.find((e) => e.kind === kind) as Extract<EmailEvidence, { kind: K }>;
}

describe("the sender", () => {
  it("is parsed from the forms mail clients write", () => {
    expect(parseFrom('"Anthropic, PBC" <Invoice@Mail.Anthropic.com>')).toEqual({
      name: "Anthropic, PBC",
      address: "invoice@mail.anthropic.com",
    });
    expect(parseFrom("billing@razorpay.com")).toEqual({
      name: "",
      address: "billing@razorpay.com",
    });
  });

  it("names the vendor by its own address before its display name", () => {
    const own = find(evidence("Receipts <receipts@anthropic.com>", "Your receipt"), "SENDER");
    const typed = find(evidence("Anthropic <noreply@stripe.com>", "Your receipt"), "SENDER");

    expect(own.agreement).toBe("VENDOR_ADDRESS");
    expect(typed.agreement).toBe("VENDOR_NAME");
  });

  it("recognises an alias written with spaces the bank ran together", () => {
    const sender = find(evidence("Claude AI <no-reply@x.com>", "Receipt"), "SENDER");
    expect(sender.agreement).toBe("VENDOR_NAME");
  });

  it("says so when it names nobody we know", () => {
    expect(find(evidence("Stripe <receipts@stripe.com>", "Receipt"), "SENDER").agreement).toBe(
      "NONE",
    );
  });
});

describe("the subject", () => {
  it("reports the most specific invoice word it uses", () => {
    const subject = find(evidence("x@y.com", "Tax Invoice INV-2231 for April"), "SUBJECT");
    expect(subject.invoiceWord).toBe("tax invoice");
  });

  it("does not find a word inside another", () => {
    // "billing" is not "bill"; "Billboard" is not either.
    expect(find(evidence("x@y.com", "Billboard rentals update"), "SUBJECT").invoiceWord).toBeNull();
  });

  it("notes a vendor named in it", () => {
    expect(find(evidence("x@y.com", "Your Anthropic receipt"), "SUBJECT").vendorNamed).toBe(true);
  });
});

describe("the date and forwarding", () => {
  it("counts days from the payment to the message, negative when the message came first", () => {
    expect(find(evidence("x@y.com", "a", "2026-04-20T23:59:00Z"), "DATE").offsetDays).toBe(6);
    expect(find(evidence("x@y.com", "a", "2026-04-12T00:01:00Z"), "DATE").offsetDays).toBe(-2);
  });

  it("recognises a forwarded invoice by its prefix or by coming from the mailbox itself", () => {
    expect(find(evidence("me@x.com", "Fwd: Invoice"), "FORWARDED").forwarded).toBe(true);
    expect(find(evidence("FW <accounts@business.in>", "Invoice"), "FORWARDED").forwarded).toBe(
      true,
    );
    expect(find(evidence("a@b.com", "Invoice"), "FORWARDED").forwarded).toBe(false);
  });
});

describe("as sentences", () => {
  it("reads as facts the user can check", () => {
    // spec: invoice-match-review §5 — evidence, not a score.
    expect(
      describeAllEmail(evidence("Receipts <receipts@anthropic.com>", "Your Anthropic receipt")),
    ).toEqual([
      "Sent from receipts@anthropic.com, the vendor's own address",
      'Subject names the vendor and says "receipt"',
      "Arrived the same day as the payment",
    ]);
  });

  it("carries no number that is not one of the things compared", () => {
    const lines = describeAllEmail(evidence("a@b.com", "Hello", "2026-04-17T00:00:00Z"));
    expect(lines.join(" ")).not.toMatch(/%|score|confiden/i);
  });
});

describe("choosing what to download", () => {
  let seq = 0;
  function candidate(from: string, subject: string, overrides: Record<string, unknown> = {}) {
    seq += 1;
    return {
      id: `c${seq}`,
      gmailConnectionId: "conn-a",
      gmailMessageId: `m${seq}`,
      rfc822MessageId: null,
      evidence: evidence(from, subject),
      ...overrides,
    };
  }

  it("leaves a message whose headers say nothing about the payment", () => {
    // A newsletter whose body happened to match: kept, never downloaded.
    const weak = candidate("news@somewhere.com", "Our spring update");
    expect(hasSignal(weak.evidence)).toBe(false);
    expect(selectForFetching([weak]).selected.size).toBe(0);
  });

  it("takes a message from the vendor even when the subject is generic", () => {
    const generic = candidate("Receipts <receipts@anthropic.com>", "Document 44812");
    expect(selectForFetching([generic]).selected).toEqual(new Set([generic.id]));
  });

  it("takes an invoice from a sender it has never heard of", () => {
    const stranger = candidate("accounts@reseller.in", "Invoice INV-9 attached");
    expect(selectForFetching([stranger]).selected.has(stranger.id)).toBe(true);
  });

  it("stops at the cap and says the shortlist is not exhaustive", () => {
    const many = Array.from({ length: MAX_MESSAGES_FETCHED + 2 }, () =>
      candidate("receipts@anthropic.com", "Receipt"),
    );

    const selection = selectForFetching(many);

    expect(selection.selected.size).toBe(MAX_MESSAGES_FETCHED);
    expect(selection.exhaustive).toBe(false);
  });

  it("prefers the vendor's own mail to a stranger's invoice when it must choose", () => {
    const strangers = Array.from({ length: MAX_MESSAGES_FETCHED }, () =>
      candidate("a@reseller.in", "Invoice"),
    );
    const vendor = candidate("receipts@anthropic.com", "Your Anthropic receipt");

    expect(selectForFetching([...strangers, vendor]).selected.has(vendor.id)).toBe(true);
  });

  it("counts the same mail in two mailboxes once, and keeps both", () => {
    const shared = { rfc822MessageId: "<same@anthropic.com>" };
    const inA = candidate("receipts@anthropic.com", "Receipt", shared);
    const inB = candidate("receipts@anthropic.com", "Receipt", {
      ...shared,
      gmailConnectionId: "conn-b",
    });
    const others = Array.from({ length: MAX_MESSAGES_FETCHED - 1 }, () =>
      candidate("receipts@anthropic.com", "Receipt"),
    );

    const selection = selectForFetching([inA, inB, ...others]);

    expect(selection.selected.has(inA.id) && selection.selected.has(inB.id)).toBe(true);
    expect(selection.exhaustive).toBe(true);
  });

  it("chooses the same messages whatever order they arrive in", () => {
    const set = Array.from({ length: MAX_MESSAGES_FETCHED + 3 }, () =>
      candidate("receipts@anthropic.com", "Receipt"),
    );
    const forward = selectForFetching(set).selected;
    const backward = selectForFetching([...set].reverse()).selected;

    expect([...backward].sort()).toEqual([...forward].sort());
  });
});
