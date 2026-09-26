/**
 * The Excel file itself.
 *
 * spec: docs/workflows/missing-invoice-report.md §5, §9
 * decision: docs/decisions/0017-reconciliation-export.md
 *
 * Pure in the sense that matters: rows and a summary in, bytes out. No database, no store,
 * no request. That keeps every claim the file makes testable by opening the bytes, and it
 * keeps this module reachable only from the background workflow that calls it.
 *
 * Every link is `<origin>/documents/<id>` -- the document's page in the application, where
 * signing in is required. Nothing that reaches this module can be a storage reference:
 * `ExportDocument` carries an id and a filename, and nothing else.
 */

import ExcelJS from "exceljs";

import type { Summary } from "../report/summary";
import type { ExportRow } from "./rows";

export interface WorkbookContext {
  /** Where links point, e.g. `https://www.ledgerwick.com`. No trailing slash. */
  readonly origin: string;
  readonly generatedAt: Date;
  readonly transactionsProcessed: number;
  readonly summary: Summary;
  /** The latest run's date and coverage, when there is one. */
  readonly run: {
    readonly startedAt: Date;
    readonly coverageStart: string | null;
    readonly coverageEnd: string | null;
  } | null;
  readonly accounts: readonly string[];
}

export const RECONCILIATION_SHEET = "Reconciliation";
export const SUMMARY_SHEET = "Summary";

/** §9's columns, in order. The headers are the contract a test pins. */
const COLUMNS: { header: string; key: keyof ExportRow; width: number }[] = [
  { header: "Date", key: "date", width: 12 },
  { header: "Account", key: "account", width: 22 },
  { header: "Description", key: "description", width: 44 },
  { header: "Direction", key: "direction", width: 10 },
  { header: "Amount", key: "amount", width: 14 },
  { header: "Currency", key: "currency", width: 10 },
  { header: "Vendor", key: "vendor", width: 24 },
  { header: "Document needed", key: "documentNeeded", width: 32 },
  { header: "Status", key: "status", width: 22 },
  { header: "How resolved", key: "howResolved", width: 22 },
  { header: "Reason", key: "reason", width: 44 },
  { header: "Document", key: "document", width: 32 },
];

export const COLUMN_HEADERS = COLUMNS.map((column) => column.header);

/** An ISO date as a date cell. UTC midnight, so no timezone can move it a day. */
function dateCell(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function documentLink(origin: string, documentId: string): string {
  return `${origin}/documents/${documentId}`;
}

export async function buildWorkbook(
  rows: readonly ExportRow[],
  context: WorkbookContext,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Ledgerwick";
  workbook.created = context.generatedAt;

  const sheet = workbook.addWorksheet(RECONCILIATION_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = COLUMNS;
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn("date").numFmt = "yyyy-mm-dd";
  sheet.getColumn("amount").numFmt = "#,##0.00";

  for (const row of rows) {
    const added = sheet.addRow({
      ...row,
      date: dateCell(row.date),
      document: row.document
        ? { text: row.document.filename, hyperlink: documentLink(context.origin, row.document.id) }
        : null,
    });
    // A currency without minor units shows none, rather than a ".00" it never had.
    if (Number.isInteger(row.amount)) added.getCell("amount").numFmt = "#,##0";
  }

  summarySheet(workbook, context);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/**
 * §5, repeated in the file, so it can be checked against itself: the lines here are the
 * same buckets the rows' Status column counts.
 */
function summarySheet(workbook: ExcelJS.Workbook, context: WorkbookContext): void {
  const sheet = workbook.addWorksheet(SUMMARY_SHEET);
  sheet.columns = [
    { key: "label", width: 32 },
    { key: "value", width: 40 },
  ];

  const { summary, run } = context;
  const lines: [string, string | number | Date][] = [
    ["Generated (UTC)", context.generatedAt],
    ["Transactions processed", context.transactionsProcessed],
    ["Needed a document", summary.documentsRequired],
    ["Matched", summary.matched],
    ["Not found", summary.notFound],
    ["Needs review", summary.needsReview],
    ["Waiting for a document", summary.waiting],
    ["Waiting on a mailbox", summary.blocked],
    ["Marked as needing no document", summary.notRequired],
  ];
  if (run) {
    lines.push(["Last run (UTC)", run.startedAt]);
    if (run.coverageStart && run.coverageEnd) {
      lines.push(["Coverage", `${run.coverageStart} → ${run.coverageEnd}`]);
    }
  }
  if (context.accounts.length > 0) lines.push(["Accounts", context.accounts.join(", ")]);

  for (const [label, value] of lines) {
    const row = sheet.addRow({ label, value });
    row.getCell("label").font = { bold: true };
    if (value instanceof Date) row.getCell("value").numFmt = "yyyy-mm-dd hh:mm";
    else row.getCell("value").alignment = { horizontal: "left" };
  }
}
