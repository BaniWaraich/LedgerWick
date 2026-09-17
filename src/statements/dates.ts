/**
 * Reading a value date off a bank statement.
 *
 * spec: docs/workflows/upload-statement.md Step 4
 * decision: docs/decisions/0003-llm-for-structure-not-values.md
 *
 * The sibling of `src/money/amounts.ts`, and it exists for the same reason: once a model
 * has said which column holds the date, code reads every one of them.
 *
 * The whole difficulty is one ambiguity. `01/08/2023` is the first of August in Mumbai and
 * the eighth of January in New York, and the cell cannot settle it — both readings are
 * valid dates, so there is no malformed input to catch and nothing to fall back on. Get it
 * wrong and the statement still balances perfectly, because `docs/decisions/0003` says in
 * as many words that the balance equation is indifferent to a corrupted date. It surfaces
 * much later, as an invoice matched to the wrong month.
 *
 * So the ordering is not guessed here. It is a property of the file, decided once by the
 * column mapping from a sample where the evidence is actually available — a day above 12
 * anywhere in the column settles it outright — and then applied to every row without
 * re-deciding. The same reasoning as the decimal separator in `amounts.ts`.
 *
 * One exception, and it is safe: a month printed by name is unambiguous on its own, so
 * `4-JAN-2024` is read as January whatever the mapping says. A statement that mixes a
 * named month into a numeric column has told us the answer for that row.
 */

/** How the file orders a numeric date. A structural claim, from the column mapping. */
export type DateOrder = "DMY" | "MDY" | "YMD";

/** A calendar date as the database stores it: `YYYY-MM-DD`, no time, no zone. */
export type IsoDate = string;

const MONTH_NAMES: ReadonlyMap<string, number> = new Map(
  ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].map(
    (name, index) => [name, index + 1],
  ),
);

/** `14:32`, `14:32:07`, `2:05 PM` — a timestamp some banks append to the date cell. */
const TRAILING_TIME = /[\s,]+\d{1,2}:\d{2}(:\d{2})?(\s*[AaPp]\.?[Mm]\.?)?$/;

/** The separators a statement uses between the parts of a date, in every combination. */
const SEPARATORS = /[\s/.\-,]+/;

/**
 * Read one date cell, or decline to.
 *
 * Null for anything that is not a date — an empty cell, a column header, a description
 * that landed here because the mapping was wrong, or a well-formed-looking value that is
 * not a real day. The caller treats null as "this row is not a transaction", which is what
 * keeps repeated headers and page footers out of the statement lines.
 */
export function readDate(text: string, order: DateOrder): IsoDate | null {
  const cleaned = text.trim().replace(TRAILING_TIME, "").trim();
  if (cleaned === "") return null;

  const parts = cleaned.split(SEPARATORS).filter((part) => part !== "");
  if (parts.length !== 3) return null;

  const named = parts.findIndex((part) => MONTH_NAMES.has(part.slice(0, 3).toLowerCase()));

  const fields =
    named >= 0
      ? // A month by name settles the ordering for this row on its own, so the mapping is
        // not consulted: the other two are the day and the year, and only one of them can
        // be a year.
        namedMonthFields(parts, named)
      : numericFields(parts, order);

  if (!fields) return null;

  const { year, month, day } = fields;
  return isRealDate(year, month, day)
    ? `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
    : /* 31 April, or 29 February in a year that had 28. A date that does not exist is not a
         date we will record, whatever the ordering says. */
      null;
}

interface Fields {
  year: number;
  month: number;
  day: number;
}

function namedMonthFields(parts: string[], monthIndex: number): Fields | null {
  const month = MONTH_NAMES.get(parts[monthIndex].slice(0, 3).toLowerCase())!;
  const rest = parts.filter((_, index) => index !== monthIndex);

  const numbers = rest.map(digits);
  if (numbers.some((value) => value === null)) return null;
  const [first, second] = numbers as number[];

  // `2024 Jan 04` puts the year first; every other arrangement puts it last. Four printed
  // digits is the only reliable mark of a year, so a two-digit year leading is read as a
  // day — which is what `04 Jan 24` means anyway.
  const yearFirst = rest[0].length === 4;
  return yearFirst
    ? { year: first, month, day: second }
    : { year: expandYear(second, rest[1].length), month, day: first };
}

function numericFields(parts: string[], order: DateOrder): Fields | null {
  const numbers = parts.map(digits);
  if (numbers.some((value) => value === null)) return null;
  const [first, second, third] = numbers as number[];

  // A four-digit leading component is an ISO date regardless of what the mapping said.
  // Nothing else can be four digits in the leading position, and a file that puts one
  // there has answered the question the mapping exists to answer.
  const effective: DateOrder = parts[0].length === 4 ? "YMD" : order;

  switch (effective) {
    case "YMD":
      return { year: expandYear(first, parts[0].length), month: second, day: third };
    case "DMY":
      return { year: expandYear(third, parts[2].length), month: second, day: first };
    case "MDY":
      return { year: expandYear(third, parts[2].length), month: first, day: second };
  }
}

/** A run of digits, and nothing else. `04` is four; `4th` and `Q1` are not numbers. */
function digits(part: string): number | null {
  return /^\d+$/.test(part) ? Number(part) : null;
}

/**
 * A two-digit year, as the century a bank statement is actually from.
 *
 * `01-08-23` is 2023. There is no clock in this decision on purpose — a function whose
 * answer depends on the day it runs cannot be pinned by a test, and a golden file would
 * quietly rot. The assumption it trades for that is explicit: this product reads statements
 * from businesses operating now, so a two-digit year is in the twenty-first century.
 */
function expandYear(value: number, printedDigits: number): number {
  return printedDigits <= 2 ? 2000 + value : value;
}

/**
 * Whether these three numbers name a day that exists.
 *
 * Checked by round-tripping through the calendar rather than by a table of month lengths,
 * because that gets February right in a leap year without anyone having to remember the
 * rule. UTC throughout: these are calendar dates, and a local-time constructor would shift
 * some of them by a day depending on where the server happens to be.
 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
