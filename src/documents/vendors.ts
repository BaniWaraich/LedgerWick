/**
 * Reducing the many ways a vendor's name is written to one thing that can be looked up.
 *
 * spec: docs/workflows/manual-invoice-upload.md §7
 * domain: docs/domain-model.md §9 Rule 6 — "Vendor identity therefore cannot depend solely
 * on exact string equality."
 *
 * `§7` names the split this file sits on: "Deterministic normalization should be used where
 * possible, with semantic/LLM-based reasoning used for more ambiguous cases." Everything
 * here is the deterministic half — pure functions over strings, no model, no database — and
 * it exists to make the easy majority free so that a model is only asked about the genuinely
 * hard remainder.
 *
 * The bar it has to clear is `§7`'s own worked example: these three are one vendor.
 *
 *     ABC Foods Private Limited      an invoice's legal name
 *     ABC Foods                      the same vendor's trade name
 *     RAZORPAY*ABCFOODS              how a payment processor wrote it on a bank statement
 *
 * That last one is why the normalized form drops spaces entirely rather than collapsing
 * them. A processor writes a vendor's name with the spaces run out of it, so any form that
 * keeps them cannot match a bank description — and matching bank descriptions is the whole
 * point of normalizing at all.
 */

import { inArray } from "drizzle-orm";

import { isUniqueViolation } from "../db/errors";
import { vendorAliases, vendors } from "../db/schema";
import type { WorkspaceScope } from "../db/workspace-scope";
import type { VendorNames } from "./fields";

/**
 * Payment processors and transfer rails, whose name is written *in front of* the vendor's.
 *
 * A closed list, and deliberately so. `ANTHROPIC*CLAUDE` and `RAZORPAY*ABCFOODS` have the
 * same shape and opposite meanings: in the first the vendor is before the star, in the
 * second it is after. Nothing about the characters distinguishes them — only knowing that
 * Razorpay is a processor and Anthropic is not.
 *
 * So this strips a prefix only when it recognises the prefix, and leaves anything else
 * alone. A vendor whose processor is not here is the "more ambiguous case" `§7` reserves for
 * the model, which is a better outcome than a rule that guesses and takes `ANTHROPIC` off
 * an Anthropic invoice.
 */
const PROCESSOR_PREFIXES: readonly string[] = [
  "razorpay",
  "payu",
  "billdesk",
  "ccavenue",
  "instamojo",
  "cashfree",
  "paytm",
  "phonepe",
  "stripe",
  "paypal",
  "sq",
  "square",
];

/** `RAZORPAY*ABCFOODS`, `PAYU/ABC FOODS`, `STRIPE PAYMENTS UK ABC FOODS`. */
const PROCESSOR_PREFIX = new RegExp(
  `^(?:${PROCESSOR_PREFIXES.join("|")})\\s*(?:payments?|pvt|india)?\\s*[*/|:\\-]\\s*`,
  "i",
);

/**
 * The bank rails that prefix a transfer with its own vocabulary.
 *
 * `NEFT-DR-ABCD0001234-XYZ SERVICES` is three fields and a payee. Unlike the processors
 * above these carry no vendor name of their own, so stripping them is unambiguous.
 */
const RAIL_PREFIX = /^(?:upi|neft|imps|rtgs|ach|ecs|mmt|inf|pos|atw|chq)[/\-\s](?:dr|cr)?[/\-\s]?/i;

/**
 * A bank reference sitting between the rail and the payee: `ABCD0001234`, `9922`.
 *
 * Only removed at the front, and only when something is left after it. A code in the middle
 * of a name is not a reference, it is the name.
 */
const LEADING_REFERENCE = /^[a-z]{0,4}\d{4,}[a-z0-9]*[/\-\s]+/i;

/**
 * A trailing reference number: `ANTHROPIC*CLAUDE 8829`, `AMAZON ORDER 402-1188393`.
 *
 * Four digits or more, because a vendor's own name can legitimately end in a small number —
 * `Studio 5`, `Formula 1` — and losing that would merge two real vendors.
 */
const TRAILING_REFERENCE = /[\s*/\-#]+[a-z]{0,3}[\d\-]{4,}$/i;

/**
 * Corporate form, which says nothing about which company this is.
 *
 * Longest first, so that `private limited` is taken off whole rather than leaving a stray
 * `private` behind once `limited` has gone.
 */
const LEGAL_SUFFIXES: readonly string[] = [
  "private limited",
  "private ltd",
  "pvt limited",
  "pvt ltd",
  "pte ltd",
  "public limited company",
  "limited liability partnership",
  "incorporated",
  "corporation",
  "company",
  "holdings",
  "limited",
  "gmbh",
  "s a r l",
  "b v",
  "n v",
  "s a",
  "llp",
  "llc",
  "ltd",
  "inc",
  "plc",
  "corp",
  "co",
];

/** Everything that is not a letter or a digit, once the words have been dealt with. */
const NOT_ALPHANUMERIC = /[^a-z0-9]/g;

/**
 * Strip every trailing legal suffix, not merely the first.
 *
 * `ABC Foods Pvt Ltd Co` is contrived, but `Acme Holdings Limited` is not, and taking one
 * suffix off it would leave `acme holdings` to fail against `Acme`.
 */
function withoutLegalSuffixes(name: string): string {
  let rest = name;

  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      const pattern = new RegExp(`[\\s.,]+${suffix.replace(/ /g, "[\\s.]+")}\\.?$`, "i");
      if (pattern.test(rest)) {
        rest = rest.replace(pattern, "");
        changed = true;
        break;
      }
    }
  }

  return rest;
}

/**
 * The lookup key for a vendor name, from whichever kind of source it came.
 *
 * Deliberately lossy. This is not a display name and is never shown to anyone — the
 * `vendors.name` column keeps what the document actually said. This is only ever compared
 * against another of its own kind, which is what `vendor_aliases.alias_normalized` stores
 * and what its unique index is built on.
 *
 * Returns an empty string for a name that normalizes to nothing — a description that was
 * only a reference number, say. The caller treats that as "this document does not name a
 * vendor", which is not the same as naming one we have not seen.
 */
export function normalizeVendorName(name: string): string {
  let rest = name.trim().toLowerCase();

  // Prefixes first, and rails before references: the reference sits between the rail and
  // the payee, so removing the rail is what exposes it.
  rest = rest.replace(PROCESSOR_PREFIX, "");
  rest = rest.replace(RAIL_PREFIX, "");
  rest = rest.replace(LEADING_REFERENCE, "");
  rest = rest.replace(TRAILING_REFERENCE, "");

  rest = withoutLegalSuffixes(rest);

  return rest.replace(NOT_ALPHANUMERIC, "");
}

/**
 * Every lookup key worth trying for one vendor, best first.
 *
 * An invoice gives several names for the same company — a legal name, a trade name, and
 * whatever aliases the model spotted on the page — and `§7` requires them all to be capable
 * of resolving to one vendor. Normalizing each and searching for any of them is what makes
 * a later bank description written in any of those forms find this vendor.
 *
 * Empty and duplicate keys are dropped, so a caller can pass nulls without thinking about it.
 */
export function vendorLookupKeys(names: readonly (string | null | undefined)[]): string[] {
  const keys: string[] = [];

  for (const name of names) {
    if (!name) continue;
    const key = normalizeVendorName(name);
    if (key !== "" && !keys.includes(key)) keys.push(key);
  }

  return keys;
}

/**
 * Find the vendor an invoice's names refer to, or record a new one.
 *
 * spec: docs/workflows/manual-invoice-upload.md §7
 * invariant: docs/domain-model.md §10 invariant 18 — Business Knowledge comes only from a
 * confirmed decision.
 *
 * Lookup is by normalized alias rather than by name, which is what makes the three forms of
 * `§7`'s worked example find each other. Every name the document gave is searched, because
 * any one of them may be the one already recorded.
 *
 * **Every alias written here is unconfirmed, always.** An invoice is evidence, not a
 * decision: it is good reason to believe `ABC Foods Private Limited` trades as `ABC Foods`,
 * and it is not the user saying so. `architecture.md §11` draws that line — "Unconfirmed
 * model guesses should not automatically become permanent business facts" — and only
 * feature H, acting on a confirmation, may set `confirmed`. Nothing in this module does.
 *
 * Returns null when the document named nobody, which is not the same as naming someone we
 * have not seen: there is no vendor to create from a page with no issuer on it.
 */
export async function resolveVendor(
  scope: WorkspaceScope,
  names: VendorNames,
): Promise<string | null> {
  const keys = vendorLookupKeys([names.legalName, names.tradeName, ...names.aliases]);
  if (keys.length === 0) return null;

  const existing = await findByAliases(scope, keys);
  if (existing) return existing;

  /*
   * The display name is what a person would call them, and the legal name is kept beside
   * it. `vendors.name` is shown; the normalized keys are not, and are never shown.
   */
  const [vendor] = await scope.insert(vendors, {
    name: names.tradeName ?? names.legalName ?? keys[0],
    legalName: names.legalName,
  });

  for (const key of keys) {
    try {
      await scope.insert(vendorAliases, {
        vendorId: vendor.id,
        alias: key,
        aliasNormalized: key,
        confirmed: false,
      });
    } catch (error) {
      /*
       * Another document reached this vendor first.
       *
       * `vendor_aliases_identity_idx` is unique on (workspace, normalized alias), and
       * leaning on it rather than checking first is the pattern `src/requirements/
       * identify.ts` already uses: a check-then-insert has a window between the two, and
       * two Gmail attachments from one vendor arriving together sit in exactly that window.
       *
       * The loser keeps the vendor row it created, which is then unreachable by lookup and
       * harmless -- an orphan, not a duplicate anyone sees. Feature H's merge screen is
       * where that would be tidied, and phase-1.md §3 defers it deliberately.
       */
      if (!isUniqueViolation(error)) throw error;
    }
  }

  // Re-read rather than returning `vendor.id`: if any key collided, the vendor that owns it
  // is the one every later document will find, and returning the orphan would split them.
  return (await findByAliases(scope, keys)) ?? vendor.id;
}

/** The vendor owning any of these normalized aliases, if one already does. */
async function findByAliases(scope: WorkspaceScope, keys: string[]): Promise<string | null> {
  const rows = await scope.select(vendorAliases, inArray(vendorAliases.aliasNormalized, keys));
  return rows[0]?.vendorId ?? null;
}
