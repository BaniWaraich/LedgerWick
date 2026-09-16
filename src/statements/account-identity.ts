/**
 * When two statements name the same account.
 *
 * spec: docs/workflows/upload-statement.md Step 3a
 *
 * Step 3a matches on the bank plus the account identifier, scoped to the workspace. This
 * module holds the one detail that rule leaves unsaid: how exactly two names are compared.
 *
 * It exists because the obvious answer — compare them literally — is wrong in a way that is
 * invisible until it has already done damage. Identification asks a model to report the bank
 * name "as printed", and a model reading the same Axis Bank statement on two occasions
 * returned `AXIS BANK` once and `Axis Bank` the next time. Under a literal comparison those
 * are two accounts. Two accounts is not a cosmetic problem: canonical transactions are keyed
 * on `bankAccountId`, so the same payment arriving under two spellings becomes two canonical
 * transactions, and `upload-statement.md` Step 5a calls a false split the failure that
 * silently destroys a real payment.
 *
 * The comparison is deliberately conservative, in the same spirit as the description
 * normalization Step 5a describes: it folds away how a document was typeset, and nothing
 * else. `HDFC Bank` and `HDFC BANK LIMITED` remain two different banks here, because deciding
 * that they are the same institution is entity resolution — a real problem, with real false
 * positives, and not one to solve silently inside an equality check.
 */

/**
 * The bank name, as identity rather than as text.
 *
 * Case and surrounding space only. Must match `lower(bank_name)` in
 * `bank_accounts_identity_idx`: the index is what actually enforces uniqueness, so a rule
 * here that disagreed with it would produce a lookup that misses followed by an insert that
 * throws.
 */
export function bankNameKey(bankName: string): string {
  return bankName.trim().toLowerCase();
}

/**
 * The account identifier, as identity rather than as text.
 *
 * Upper-cased for the same reason, and for one of its own: masked identifiers are printed
 * both as `XXXX1234` and as `xxxx1234`, sometimes by the same bank on different pages.
 * Must match `upper(account_identifier)` in `bank_accounts_identity_idx`.
 *
 * Nothing else is stripped. Spaces inside an IBAN and punctuation inside an account number
 * are left exactly as they are: removing them would merge identifiers that a bank may well
 * intend to be distinct, and a wrong merge is the expensive direction of this decision.
 */
export function accountIdentifierKey(accountIdentifier: string): string {
  return accountIdentifier.trim().toUpperCase();
}
