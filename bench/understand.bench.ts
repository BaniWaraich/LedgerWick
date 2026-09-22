/**
 * The extraction bench: run the real reading over real invoices, and write down what it saw.
 *
 * ## Why this exists
 *
 * `docs/extraction-acceptance.md` says the only evidence that extraction generalises is how
 * often it is wrong about an invoice it has never seen, and `0010` names the error this has
 * to make visible: locators catch a misreading, and do nothing about a **mislocation** — a
 * model that confidently transcribes the subtotal into `total` produces a perfectly
 * parseable span and a wrong invoice.
 *
 * Nothing in the code can catch that. An invoice has no balance equation, no second figure
 * to check the first against. Only a person holding the document beside the output can, and
 * this exists to put those two things side by side.
 *
 * So the dump leads with **the span next to the value it became**. That is the line to read:
 *
 *     total        "Rs. 1,20,000.00"  ->  12000000  INR
 *     invoiceDate  "14/04/2026"       ->  2026-04-14
 *
 * A wrong number is obvious. A right number read off the wrong line is only obvious if you
 * can see which characters it came from.
 *
 * It is a microscope, not a test: nothing in here asserts, and a red run means the harness
 * broke, not that a document failed. A document's verdict goes in the log in
 * `docs/extraction-acceptance.md`, written by a person, before anything is fixed.
 *
 * ## The reading cache
 *
 * `bench/out/<name>/reading.json` is written on the first run and reused after, exactly as
 * the parse bench caches its mapping, and for the same two reasons. Iterating on `fields.ts`
 * or `vendors.ts` is then free and instant with no spend, and a cached reading can be
 * **edited by hand** — which is how you ask "did the model read the wrong line, or did we
 * parse the right one badly?" without changing a line of code.
 *
 * `BENCH_REREAD=1` throws the cache away and asks the model again.
 *
 * ## Running it
 *
 *   npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *   BENCH_ONLY=acme BENCH_REREAD=1 npx dotenv -e .env.local -- npx vitest run --config bench/vitest.config.ts
 *
 * Put invoices in `fixtures/invoices/inbox/` as they arrived, unredacted. That directory is
 * git-ignored and stays that way; a file leaves it by being redacted and moved up into
 * `fixtures/invoices/`, which is tracked (BAN-150).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { generateObject } from "ai";
import { describe, it } from "vitest";

import {
  invoiceReadingSchema,
  readInvoicePrompt,
  type InvoiceReading,
} from "../src/ai/prompts/read-invoice.v1";
import type { ExtractPdfText } from "../src/documents/contracts";
import { anchored, hasMinimumFields, invoiceFieldsFrom } from "../src/documents/fields";
import { readDocumentContent } from "../src/documents/text";
import { normalizeVendorName, vendorLookupKeys } from "../src/documents/vendors";
import type { PositionedText } from "../src/statements/pdf-grid";

const INBOX = path.resolve(__dirname, "../fixtures/invoices/inbox");
const OUT = path.resolve(__dirname, "out");

/** `pdf-text.ts` behind `server-only`, reimplemented for a plain Node process. */
const extractPdfText: ExtractPdfText = async (bytes) => {
  const { extractTextItems } = await import("unpdf");
  const { totalPages, items } = await extractTextItems(bytes);
  return {
    pages: totalPages,
    items: items.map((page) =>
      page.map((item): PositionedText => ({
        text: item.str,
        x: item.x,
        y: item.y,
        width: item.width,
      })),
    ),
  };
};

/**
 * The reading for this document: from disk if it is there, from the model otherwise.
 *
 * Deliberately not `src/documents/reader.ts` — that is `server-only` and cannot be imported
 * into a plain Node process. It is the same prompt and the same schema, called the same way,
 * which is what the bench needs to be measuring.
 */
async function reading(
  name: string,
  content: { type: "text"; text: string } | { type: "file"; data: Uint8Array; mediaType: string },
): Promise<InvoiceReading> {
  const cached = path.join(OUT, name, "reading.json");

  if (!process.env.BENCH_REREAD) {
    try {
      const parsed = invoiceReadingSchema.safeParse(JSON.parse(await readFile(cached, "utf8")));
      if (parsed.success) {
        console.log(`  reading: cached (edit ${path.relative(process.cwd(), cached)} to probe)`);
        return parsed.data;
      }
      console.log("  reading: cached copy no longer fits the schema — asking again");
    } catch {
      /* no cache yet */
    }
  }

  const { object } = await generateObject({
    model: process.env.AI_MODEL?.trim() || "anthropic/claude-sonnet-5",
    schema: invoiceReadingSchema,
    system: readInvoicePrompt.system,
    messages: [{ role: "user", content: [content] }],
  });

  await writeFile(cached, JSON.stringify(object, null, 2));
  return object;
}

/**
 * Every span beside the value it became.
 *
 * The heart of the dump, and the only view that makes a mislocation visible. Read it with
 * the document open: the question is never "is 12000000 plausible" but "is Rs. 1,20,000.00
 * the line on this page that a person would pay".
 */
function renderFields(read: InvoiceReading, sourceText?: string): string {
  const fields = invoiceFieldsFrom(read, sourceText);
  const rows: string[] = [];

  /*
   * Whether the characters are on the page, shown per field rather than only as a drop.
   *
   * `!` marks a span the model produced rather than read, which is the single most valuable
   * thing this bench can surface -- and it is invisible from the value alone, because an
   * invented figure parses exactly as cleanly as a real one.
   */
  const mark = (span: string | null, checked = true): string => {
    if (span === null || sourceText === undefined || !checked) return " ";
    return anchored(span, sourceText) ? " " : "!";
  };

  const line = (label: string, span: string | null, value: string, checked = true) =>
    rows.push(
      `${mark(span, checked)} ${label.padEnd(13)} ${(span === null ? "—" : JSON.stringify(span)).padEnd(24)} -> ${value}`,
    );

  line(
    "total",
    read.total?.text ?? null,
    `${fields.totalMinor ?? "—"}  ${fields.currency?.code ?? "?"}`,
  );
  line("tax", read.tax?.text ?? null, `${fields.taxMinor ?? "—"}`);
  line("subtotal", read.subtotal?.text ?? null, `${fields.subtotalMinor ?? "—"}`);
  line(
    "invoiceDate",
    read.invoiceDate?.text ?? null,
    `${fields.invoiceDate ?? "—"}  (${read.dateOrder})`,
  );
  /*
   * Not anchored, and therefore not marked.
   *
   * `fields.ts` checks the money and date spans only. An invoice number is an identifier
   * rather than a value -- it carries letters, and the digit reduction the anchor uses would
   * compare `ABC-2201` and `XYZ-2201` as the same. Marking it here would imply a guarantee
   * that does not exist, which is worse than showing nothing.
   */
  line("invoiceNumber", read.invoiceNumber, read.invoiceNumber ?? "—", false);

  const names = read.vendor;
  rows.push("");
  rows.push(
    `  vendor        legal=${JSON.stringify(names?.legalName ?? null)} trade=${JSON.stringify(names?.tradeName ?? null)}`,
  );
  rows.push(`  aliases       ${JSON.stringify(names?.aliases ?? [])}`);
  rows.push(
    `  lookup keys   ${JSON.stringify(
      vendorLookupKeys([names?.legalName, names?.tradeName, ...(names?.aliases ?? [])]),
    )}`,
  );

  if (fields.unparsed.length > 0) {
    rows.push("");
    rows.push("  DROPPED:");
    for (const entry of fields.unparsed) {
      const why =
        entry.reason === "NOT_ON_PAGE"
          ? "NOT ON PAGE — the model produced these characters rather than reading them"
          : "would not parse as a value";
      rows.push(`    ${entry.field.padEnd(13)} ${JSON.stringify(entry.text).padEnd(24)} ${why}`);
    }
  }

  if (sourceText === undefined) {
    rows.push("");
    rows.push("  (visual path — no extracted text, so nothing could be anchored)");
  }

  rows.push("");
  rows.push(`  classification ${read.classification}`);
  rows.push(`  documentType   ${read.documentType ?? "—"}`);
  rows.push(`  reason         ${read.reason}`);
  rows.push("");
  rows.push(
    `  OUTCOME        ${
      read.classification === "IS_NOT_INVOICE"
        ? "NOT_AN_INVOICE"
        : hasMinimumFields(fields)
          ? "EXTRACTED"
          : "UNREADABLE (read, but short of vendor + total + date)"
    }`,
  );

  return rows.join("\n");
}

/** Everything one document produced, on disk, for reading against the original. */
async function dump(name: string, files: Record<string, string>): Promise<void> {
  await mkdir(path.join(OUT, name), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await writeFile(path.join(OUT, name, file), body);
  }
}

const documents = existsSync(INBOX)
  ? readdirSync(INBOX)
      .filter((file) => /\.(pdf|jpe?g|png|webp)$/i.test(file))
      .filter(
        (file) =>
          !process.env.BENCH_ONLY ||
          file.toLowerCase().includes(process.env.BENCH_ONLY.toLowerCase()),
      )
  : [];

describe("extraction bench", () => {
  if (documents.length === 0) {
    // Not a failure. The corpus is a human-blocked task (BAN-150), and an empty inbox on a
    // fresh clone is the ordinary state rather than a broken harness.
    it.skip("no documents in fixtures/invoices/inbox — see BAN-150", () => {});
    return;
  }

  for (const file of documents) {
    const name = file.replace(/\.[^.]+$/, "").replace(/\s+/g, "-");

    it(name, async () => {
      await mkdir(path.join(OUT, name), { recursive: true });
      console.log(`\n=== ${file} ===`);

      const bytes = new Uint8Array(await readFile(path.join(INBOX, file)));
      const content = await readDocumentContent(bytes, extractPdfText);

      if (!content) {
        console.log("  path: UNREADABLE — neither a PDF nor an image this system accepts");
        await dump(name, { "fields.txt": "UNREADABLE: the file could not be read at all\n" });
        return;
      }

      console.log(`  path: ${content.path}`);
      if (content.path === "TEXT") {
        console.log(`  characters: ${content.text.length}`);
        await dump(name, { "text.txt": content.text });
      } else {
        console.log(`  mediaType: ${content.mediaType} — the model reads the document itself`);
      }

      const read = await reading(
        name,
        content.path === "TEXT"
          ? { type: "text", text: content.text }
          : { type: "file", data: content.bytes, mediaType: content.mediaType },
      );

      const rendered = renderFields(read, content.path === "TEXT" ? content.text : undefined);
      console.log(rendered);

      await dump(name, {
        "fields.txt": `${rendered}\n`,
        "normalized.txt": [
          read.vendor?.legalName,
          read.vendor?.tradeName,
          ...(read.vendor?.aliases ?? []),
        ]
          .filter((value): value is string => Boolean(value))
          .map(
            (value) => `${JSON.stringify(value)} -> ${JSON.stringify(normalizeVendorName(value))}`,
          )
          .join("\n"),
      });
    });
  }
});
