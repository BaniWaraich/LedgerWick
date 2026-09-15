"use client";

/**
 * The question `NEEDS_ACCOUNT` asks, and the form that answers it.
 *
 * Step 3a: "If the document does not state which account it covers, the user chooses."
 * Either an account already in this workspace, or a new one. What the document did say is
 * offered as a starting point for the new-account fields — a suggestion the user can
 * correct, never a value bound on its own.
 */

import { useActionState } from "react";

import { bindAccountAction, type BindFormState } from "../actions";
import styles from "./page.module.css";

interface Account {
  id: string;
  bankName: string;
  accountIdentifier: string;
}

export function AccountPicker({
  statementId,
  accounts,
  suggestedBankName,
  suggestedAccountIdentifier,
}: {
  statementId: string;
  accounts: Account[];
  suggestedBankName: string | null;
  suggestedAccountIdentifier: string | null;
}) {
  const [state, action, pending] = useActionState<BindFormState, FormData>(bindAccountAction, {});

  return (
    <form className={styles.picker} action={action}>
      <input type="hidden" name="statementId" value={statementId} />

      {accounts.length > 0 ? (
        <label className={styles.field}>
          <span className={styles.label}>Use an account you already have</span>
          <select className={styles.select} name="bankAccountId" defaultValue="">
            <option value="">Add a new account instead</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.bankName} · {account.accountIdentifier}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className={styles.newAccount}>
        <label className={styles.field}>
          <span className={styles.label}>Bank</span>
          <input
            className={styles.input}
            name="bankName"
            defaultValue={suggestedBankName ?? ""}
            placeholder="HDFC Bank"
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Account number, as printed</span>
          <input
            className={styles.input}
            name="accountIdentifier"
            defaultValue={suggestedAccountIdentifier ?? ""}
            placeholder="XXXX1234"
          />
        </label>
      </div>

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <button className={styles.submit} type="submit" disabled={pending}>
        {pending ? "Saving…" : "Use this account"}
      </button>
    </form>
  );
}
