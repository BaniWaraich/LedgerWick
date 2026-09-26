/**
 * The whole retrieval path, driven through its domain entry points, with scripted models.
 *
 * What the two Inngest functions do, in order, without Inngest: search, fetch, assess each
 * document, settle. The reader and the adjudicator are scripted, so what these tests
 * measure is the pipeline and the policy -- not a model. Model quality is measured by the
 * bench and `docs/retrieval-acceptance.md`, once the gateway has credit (`BAN-149`).
 *
 * A "paper" is a PDF these tests can make: its bytes carry a key the scripted reader looks
 * for, and the text the reading's spans must be found in (`docs/decisions/0010`).
 */

import type { InvoiceReading } from "../../src/ai/prompts/read-invoice.v1";
import type { ExtractPdfText, ReadInvoice } from "../../src/documents/contracts";
import type { AdjudicateMatch, JudgeSameInvoice } from "../../src/matching/contracts";
import { assessDocument, settleRetrieval, type AssessDeps } from "../../src/retrieval/assess";
import { documentsFor, fetchForRequirement } from "../../src/retrieval/fetch";
import { searchRequirement } from "../../src/retrieval/search";
import { FakeDocumentStore } from "../storage/fake-document-store";
import type { World } from "./world";

/** What the scripted reader says about one paper. */
export type Script = InvoiceReading | "UNREADABLE" | "NOT_AN_INVOICE";

export interface Paper {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly script: Script;
}

export function reading(over: Partial<InvoiceReading> = {}): InvoiceReading {
  return {
    classification: "IS_INVOICE",
    reason: "A receipt from Anthropic for Claude Pro.",
    documentType: "Receipt",
    vendor: { legalName: "Anthropic, PBC", tradeName: "Anthropic", aliases: [] },
    invoiceNumber: "2231-9912",
    invoiceDate: { text: "14/04/2026" },
    dateOrder: "DMY",
    currency: "USD",
    decimalSeparator: ".",
    total: { text: "20.00" },
    tax: null,
    subtotal: null,
    ...over,
  };
}

/** A PDF whose text carries every span its reading reports. */
export function paper(key: string, script: Script = reading()): Paper {
  const spans =
    typeof script === "string"
      ? "Terms of service update, effective 1 May 2026"
      : [
          script.vendor?.legalName,
          script.invoiceNumber,
          script.invoiceDate?.text,
          script.total?.text,
          script.currency,
        ]
          .filter(Boolean)
          .join(" ");
  const text = `%PDF-1.7\n[${key}] ${spans} ${"Receipt line item Claude Pro subscription 1 x ".repeat(2)}`;
  return { key, bytes: new TextEncoder().encode(text), script };
}

/** The text layer of a paper: its own bytes, read as text. */
export const extractPdfText: ExtractPdfText = async (bytes) => ({
  pages: 1,
  items: [
    [{ text: new TextDecoder().decode(bytes).replace(/^%PDF-1\.7\n/, ""), x: 0, y: 0, width: 500 }],
  ],
});

export const agrees: AdjudicateMatch = async () => ({
  ok: true,
  value: { candidate: 0, verdict: "SAME", reason: "Same vendor, amount and day." },
});

export const unsure: AdjudicateMatch = async () => ({
  ok: true,
  value: { candidate: 0, verdict: "UNSURE", reason: "Cannot tell." },
});

export const notDuplicate: JudgeSameInvoice = async () => ({
  ok: true,
  value: { same: "NO", reason: "Different invoices." },
});

export class Pipeline {
  readonly store = new FakeDocumentStore();
  private readonly papers = new Map<string, Script>();
  /** How many times the reader was asked. Each is a model call in production. */
  reads = 0;

  constructor(
    readonly w: World,
    private readonly adjudicate: AdjudicateMatch = agrees,
  ) {}

  know(...papers: Paper[]): this {
    for (const p of papers) this.papers.set(p.key, p.script);
    return this;
  }

  private read: ReadInvoice = async (content) => {
    this.reads += 1;
    const first = content[0];
    const text = first?.type === "text" ? first.text : "";
    const key = /\[([^\]]+)\]/.exec(text)?.[1];
    const script = key === undefined ? undefined : this.papers.get(key);
    if (script === undefined || script === "UNREADABLE") {
      return { ok: false, reason: "the model could not read this" };
    }
    if (script === "NOT_AN_INVOICE") {
      return {
        ok: true,
        value: reading({
          classification: "IS_NOT_INVOICE",
          reason: "A terms-of-service notice.",
          vendor: null,
          invoiceNumber: null,
          invoiceDate: null,
          currency: null,
          total: null,
        }),
      };
    }
    return { ok: true, value: script };
  };

  deps(): AssessDeps {
    return {
      understand: { store: this.store, extractPdfText, read: this.read },
      match: {
        adjudicate: this.adjudicate,
        judgeSameInvoice: notDuplicate,
        formatAmount: (minor, currency) => (minor === null ? null : `${currency} ${minor}`),
      },
    };
  }

  fetchDeps() {
    return { ...this.w.deps(), store: this.store };
  }

  /** Search, and fetch if there is anything to fetch. What `retrieve-documents` does. */
  async searchAndFetch(requirementId: string) {
    const searched = await searchRequirement(this.w.scope, requirementId, this.w.deps());
    if (searched.kind !== "SEARCHED" || searched.next !== "FETCH")
      return { searched, fetched: null };
    const fetched = await fetchForRequirement(this.w.scope, requirementId, this.fetchDeps());
    return { searched, fetched };
  }

  /** Assess every fetched document and settle. What `assess-retrieval` does. */
  async assessAndSettle(requirementId: string) {
    const documents = await documentsFor(this.w.scope, requirementId);
    const assessments = [];
    for (const documentId of documents) {
      assessments.push(await assessDocument(this.w.scope, documentId, this.deps()));
    }
    return settleRetrieval(this.w.scope, requirementId, assessments);
  }

  /** The whole path, as the two functions run it back to back. */
  async run(requirementId: string) {
    const { searched, fetched } = await this.searchAndFetch(requirementId);
    if (fetched?.next !== "ASSESS") return { searched, fetched, settled: null };
    return { searched, fetched, settled: await this.assessAndSettle(requirementId) };
  }
}
