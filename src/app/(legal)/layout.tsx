/**
 * Chrome for the public legal pages.
 *
 * A route group so `/privacy-policy` and `/terms-and-conditions` stay at the top level of
 * the URL space — Google's OAuth verification form asks for those URLs directly, and a
 * nested path would be one more thing to get wrong.
 *
 * These pages are outside `(workspace)` deliberately: they must render for a signed-out
 * visitor and for a Google reviewer who will never create an account.
 */

import Link from "next/link";

import styles from "./legal.module.css";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <span className={`material-symbols-outlined ${styles.brandIcon}`} aria-hidden="true">
            account_balance
          </span>
          <span className={styles.brandName}>Ledgerwick</span>
        </Link>
        <Link className={styles.headerLink} href="/">
          Back to site
        </Link>
      </header>

      <main className={styles.main}>{children}</main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>© {new Date().getFullYear()} Ledgerwick</span>
          <div className={styles.footerLinks}>
            <Link href="/privacy-policy">Privacy Policy</Link>
            <Link href="/terms-and-conditions">Terms &amp; Conditions</Link>
            <a href="mailto:waraichbani@gmail.com">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
