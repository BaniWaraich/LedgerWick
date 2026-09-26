/**
 * What the review screen offers, and what it must never show.
 *
 * spec: docs/workflows/invoice-match-review.md §5, §6, §7, §9
 *
 * The actions module is mocked, as `poll.test.tsx` mocks `next/navigation`: a client
 * component importing a `"use server"` file would otherwise drag the session, the
 * database and the Inngest client into a jsdom test. What the actions themselves do is
 * covered by `tests/review/resolve.test.ts` against a real database.
 *
 * So what is testable here is the part only the markup can answer: that the evidence
 * appears as sentences, that no percentage does, that every outcome §6 names is reachable,
 * and that the preview points at the application rather than at storage.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const submitted: FormData[] = [];

vi.mock("../../src/app/(workspace)/reconciliation/[requirementId]/actions", () => ({
  resolveRequirementAction: async (_previous: unknown, formData: FormData) => {
    submitted.push(formData);
    return {};
  },
}));

const { DecisionForm } =
  await import("../../src/app/(workspace)/reconciliation/[requirementId]/decision-form");

import type { ReviewCandidate } from "../../src/review/context";

afterEach(() => {
  cleanup();
  submitted.length = 0;
});

function candidate(overrides: Partial<ReviewCandidate> = {}): ReviewCandidate {
  return {
    invoiceId: "11111111-1111-4111-8111-111111111111",
    documentId: "22222222-2222-4222-8222-222222222222",
    filename: "Receipt-INV-92831.pdf",
    source: "MANUAL_UPLOAD",
    vendorName: "Anthropic",
    invoiceNumber: "INV-92831",
    invoiceDate: "2026-04-14",
    totalMinor: 2000n,
    currency: "USD",
    mail: null,
    evidence: [
      "Amount matches exactly",
      "Dated the same day as the transaction",
      "Vendor matches ANTHROPIC in the transaction description",
      "Invoice number not present in the transaction description",
    ],
    modelReason: "The description names the same company as the invoice",
    previewHref: "/api/documents/22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

function renderForm(overrides: Partial<Parameters<typeof DecisionForm>[0]> = {}) {
  return render(
    <DecisionForm
      requirementId="33333333-3333-4333-8333-333333333333"
      transactionId="44444444-4444-4444-8444-444444444444"
      vendorGuess="Anthropic"
      canGeneralize
      candidates={[candidate()]}
      linkable={[
        { id: "55555555-5555-4555-8555-555555555555", filename: "Old.pdf", addedOn: "2026-04-01" },
      ]}
      {...overrides}
    />,
  );
}

describe("the case for a candidate", () => {
  it("is shown as the sentences §5 prints", () => {
    const { container } = renderForm();

    for (const line of candidate().evidence) {
      expect(container.textContent).toContain(line);
    }
  });

  it("is never shown as a percentage", () => {
    // §5: "A percentage tells the user nothing they can check." The view model has no
    // number to render, and this is the assertion that says the markup did not invent one.
    const { container } = renderForm();

    expect(container.textContent).not.toMatch(/\d+\s?%/);
    expect(container.textContent).not.toMatch(/confidence/i);
    expect(container.textContent).not.toMatch(/score/i);
  });

  it("shows the reader's sentence rather than its verdict as a label", () => {
    const { container } = renderForm();

    expect(container.textContent).toContain(
      "The description names the same company as the invoice",
    );
    // SAME / UNSURE / DIFFERENT are a transcript, not something to put in front of a user.
    expect(container.textContent).not.toContain("UNSURE");
  });

  it("previews through the application, never through storage", () => {
    // §5 and architecture.md §19: the preview serves the file through an authorized
    // route. The page is given a document id and never a storage key.
    const { container } = renderForm();
    const preview = container.querySelector("a[href^='/api/documents/']");

    expect(preview).not.toBeNull();
    expect(container.innerHTML).not.toContain("blob.vercel-storage");
    expect(container.innerHTML).not.toContain("storageRef");
  });
});

describe("the outcomes the screen offers", () => {
  it("offers every one §6 names", () => {
    const { container } = renderForm();
    const text = container.textContent ?? "";

    expect(text).toContain("This is the one");
    expect(text).toContain("Upload the document");
    expect(text).toContain("Link it");
    expect(text).toContain("Just this payment");
  });

  it("sends the candidate the user pressed", () => {
    const { getByText } = renderForm();

    fireEvent.click(getByText("This is the one"));

    expect(submitted).toHaveLength(1);
    expect(submitted[0].get("decision")).toBe("CONFIRM");
    expect(submitted[0].get("invoiceId")).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("sends a retrieved document nobody could read by the document itself", () => {
    // No invoice was read from it, so it is linked directly (domain-model §5.1).
    const { getByText } = renderForm({
      candidates: [candidate({ invoiceId: null, vendorName: null, invoiceNumber: null })],
    });

    fireEvent.click(getByText("This is the one"));

    expect(submitted[0].get("decision")).toBe("CONFIRM");
    expect(submitted[0].get("invoiceId")).toBe("");
    expect(submitted[0].get("candidateDocumentId")).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("shows the email a retrieved document came in, and why it was read", () => {
    // §5: "From: receipts@anthropic.com" -- headers, never the message.
    const { container } = renderForm({
      candidates: [
        candidate({
          source: "GMAIL",
          mail: {
            from: "Receipts <receipts@anthropic.com>",
            subject: "Your receipt from Anthropic",
            mailbox: "accounts@business.in",
            evidence: ["Sent from receipts@anthropic.com, the vendor's own address"],
          },
        }),
      ],
    });

    expect(container.textContent).toContain("From: Receipts <receipts@anthropic.com>");
    expect(container.textContent).toContain("found in accounts@business.in");
    expect(container.textContent).toContain("the vendor's own address");
  });

  it("pre-binds the upload link to this payment", () => {
    // §6: uploading from review enters the manual upload workflow pre-bound, and matching
    // is skipped entirely because the user has already answered the question.
    const { container } = renderForm();
    const upload = container.querySelector("a[href^='/documents/upload']");

    expect(upload?.getAttribute("href")).toBe(
      "/documents/upload?transaction=44444444-4444-4444-8444-444444444444",
    );
  });

  it("sends a rejection with no candidate attached", () => {
    const { getByText } = renderForm();

    fireEvent.click(getByText("This isn't the one"));

    expect(submitted[0].get("decision")).toBe("REJECT_ALL");
  });
});

describe("asking how far 'no document needed' goes", () => {
  it("offers both breadths when there is a vendor to key on", () => {
    // §9: "Where the generalization is uncertain, ask rather than assume — and ask once."
    const { container } = renderForm();

    expect(container.textContent).toContain("Just this payment");
    expect(container.textContent).toContain("Every payment to Anthropic");
  });

  it("sends the breadth the user chose", () => {
    const { getByText } = renderForm();

    fireEvent.click(getByText("Every payment to Anthropic"));

    expect(submitted[0].get("decision")).toBe("NOT_REQUIRED_VENDOR");
  });

  it("offers only this payment when the narration named nobody", () => {
    // A choice that silently does nothing is worse than not offering it.
    const { container } = renderForm({ canGeneralize: false, vendorGuess: null });

    expect(container.textContent).toContain("Just this payment");
    expect(container.textContent).not.toContain("Every payment");
  });
});

describe("the shape of the list", () => {
  it("says 'this isn't the one' for a single candidate", () => {
    const { container } = renderForm();

    expect(container.textContent).toContain("This isn't the one");
    expect(container.textContent).not.toContain("None of these is right");
  });

  it("says 'none of these' for several", () => {
    const { container } = renderForm({
      candidates: [
        candidate(),
        candidate({
          invoiceId: "66666666-6666-4666-8666-666666666666",
          documentId: "77777777-7777-4777-8777-777777777777",
          previewHref: "/api/documents/77777777-7777-4777-8777-777777777777",
        }),
      ],
    });

    expect(container.textContent).toContain("None of these is right");
  });

  it("offers nothing to reject when there is nothing to reject", () => {
    // A button that records an empty rejection would be a lie about having done something.
    const { container } = renderForm({ candidates: [] });

    expect(container.textContent).not.toContain("None of these is right");
    expect(container.textContent).not.toContain("This isn't the one");
    // But the other outcomes are still there: §6's three do not depend on a candidate.
    expect(container.textContent).toContain("Upload the document");
  });

  it("offers no document picker when the workspace has none spare", () => {
    const { container } = renderForm({ linkable: [] });

    expect(container.textContent).not.toContain("Link it");
    expect(container.textContent).toContain("Upload the document");
  });
});
