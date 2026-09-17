/**
 * Reading a CSV statement as a grid of cells.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 *
 * ADR 0003 splits parsing into a model that identifies structure and code that walks every
 * row. The walker needs rows and columns to walk, and this is where a CSV becomes them.
 * What comes out is deliberately dumb: cells, in file order, with nothing interpreted. The
 * mapping decides which column is which, and `amounts.ts` and `dates.ts` read the values.
 *
 * Hand-rolled rather than a dependency, which is a decision and not laziness. What a bank
 * CSV throws at a reader is quoting, encoding and the choice of delimiter — a well-specified
 * problem of about sixty lines that can be pinned by tests. The awkwardness the fixtures
 * exist to capture is in the *rows*: repeated headers, wrapped descriptions, footers in the
 * middle of the table. No CSV library helps with any of that, so one would be a dependency
 * bought for the easy half (`AGENTS.md §1`).
 *
 * Two things it does not do, both on purpose:
 *
 * **Empty rows are kept.** The column mapping refers to rows by index, so silently dropping
 * a blank line between the header block and the table would shift every row under it and
 * quietly point `firstDataRowIndex` at the wrong place.
 *
 * **Rows are padded to the widest.** A short row is how most exporters write a line with no
 * trailing balance, and a caller indexing by column should get an empty cell rather than
 * `undefined`.
 */

/** A file as rows of cells, exactly as written. */
export type Grid = readonly (readonly string[])[];

/** The delimiters a bank exporter actually uses, in the order ties are broken. */
const DELIMITERS = [",", ";", "\t", "|"] as const;

/** How many lines the sniffer looks at before deciding. Enough to see the table start. */
const SNIFF_LINES = 20;

/**
 * Decode the bytes of a CSV, whatever encoding the bank wrote it in.
 *
 * UTF-16 is not exotic here: "Save as CSV" in Excel on Windows produces UTF-16LE with a
 * byte-order mark often enough that treating every file as UTF-8 turns a real statement
 * into a column of null bytes. The mark is the only reliable signal, so it is the only one
 * used — guessing an encoding that announces nothing would be a worse failure than reading
 * it as UTF-8 and finding no delimiter.
 */
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  // `ignoreBOM: false` is the default and means "strip it if present", which is what we want.
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * The delimiter this file is written with.
 *
 * Counted outside quotes only, because a description like `ACME TRADING, MUMBAI` is full of
 * commas that are not delimiters, and counting them would pick the comma for a semicolon
 * file whose descriptions happen to contain more of them.
 */
export function sniffDelimiter(text: string): string {
  let best: string = DELIMITERS[0];
  let bestCount = 0;

  for (const delimiter of DELIMITERS) {
    let count = 0;
    let quoted = false;
    let lines = 0;

    for (let i = 0; i < text.length && lines < SNIFF_LINES; i += 1) {
      const char = text[i];
      if (char === '"') {
        quoted = !quoted;
      } else if (!quoted && char === delimiter) {
        count += 1;
      } else if (!quoted && (char === "\n" || char === "\r")) {
        lines += 1;
      }
    }

    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }

  // Every candidate scored zero: a single-column file, or not tabular at all. The comma
  // yields one cell per line, which is the honest reading and lets the caller decide.
  return best;
}

/** Read a CSV into a grid. */
export function readCsvGrid(bytes: Uint8Array): Grid {
  const text = decodeCsv(bytes);
  const delimiter = sniffDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell.trim());
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      // RFC 4180 escapes a quote by doubling it. Anything else closes the field.
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        // Including a newline: a quoted field may legitimately span lines, which is how a
        // wrapped description survives an export.
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      endCell();
    } else if (char === "\r") {
      // CRLF, and a lone CR from an old Mac exporter. Either way, one row ends.
      if (text[i + 1] === "\n") i += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      cell += char;
    }
  }

  // A file that does not end in a newline still has a last row. One that does must not
  // gain an empty one.
  if (cell !== "" || row.length > 0) endRow();

  const width = rows.reduce((widest, current) => Math.max(widest, current.length), 0);
  return rows.map((current) =>
    current.length === width ? current : [...current, ...Array(width - current.length).fill("")],
  );
}
