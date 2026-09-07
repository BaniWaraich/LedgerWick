import type { Metadata } from "next";
import Link from "next/link";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Ledgerwick - Financial Reconciliations Made Simple",
  description:
    "Ledgerwick automatically finds invoices in your Gmail and matches them to your bank transactions.",
};

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={`material-symbols-outlined ${styles.brandIcon}`} aria-hidden="true">
            account_balance
          </span>
          <span className={styles.brandName}>Ledgerwick</span>
        </div>
        <nav className={styles.nav} aria-label="Primary">
          <a className={styles.navLink} href="#product">
            Product
          </a>
          <a className={styles.navLink} href="#security">
            Security
          </a>
          <a className={styles.navLink} href="#privacy">
            Privacy
          </a>
        </nav>
        <div className={styles.headerActions}>
          <Link className={`${styles.btn} ${styles.btnSecondaryHeader}`} href="/login">
            Log In
          </Link>
          <Link className={`${styles.btn} ${styles.btnPrimaryHeader}`} href="/login">
            Get Started
          </Link>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Reconcile your bank statements with your inbox in seconds.
          </h1>
          <p className={styles.heroCopy}>
            Ledgerwick automatically finds invoices in your Gmail and matches them to your bank
            transactions. Stop chasing receipts and start closing your books.
          </p>
          <div className={styles.heroActions}>
            <Link className={`${styles.btn} ${styles.btnPrimaryHero}`} href="/login">
              Get Started
            </Link>
            <Link className={`${styles.btn} ${styles.btnSecondaryHero}`} href="/login">
              Log In
            </Link>
          </div>
          <div className={styles.trust}>
            <span className={`material-symbols-outlined ${styles.trustIcon}`} aria-hidden="true">
              verified_user
            </span>
            <span className={styles.trustText}>
              Secure, private, and built for small business operations.
            </span>
          </div>
        </section>

        <section className={styles.preview} id="product" aria-label="Product preview">
          <div className={styles.previewGrid}>
            <div className={styles.mockPanel}>
              <div className={styles.mockHeader}>
                <h3 className={styles.mockTitle}>Pending Reconciliations</h3>
                <span className={styles.mockBadge}>3 Awaiting Review</span>
              </div>
              <div className={styles.mockList}>
                <div className={styles.matchRow}>
                  <div className={styles.rowLeft}>
                    <div className={`${styles.rowIcon} ${styles.rowIconMatched}`}>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        mail
                      </span>
                    </div>
                    <div className={styles.rowCopy}>
                      <p className={styles.rowTitle}>Acme Corp Invoice #204</p>
                      <p className={styles.rowMeta}>Found in inbox: billing@acme.com</p>
                    </div>
                  </div>
                  <div className={styles.rowRight}>
                    <span
                      className={`material-symbols-outlined ${styles.linkIcon}`}
                      aria-hidden="true"
                    >
                      link
                    </span>
                    <div className={styles.amountBlock}>
                      <p className={styles.amount}>$1,450.00</p>
                      <p className={styles.rowMeta}>Chase Checking •••492</p>
                    </div>
                    <span className={styles.checkButton} aria-hidden="true">
                      <span className="material-symbols-outlined">check</span>
                    </span>
                  </div>
                </div>

                <div className={styles.pendingRow}>
                  <div className={styles.rowLeft}>
                    <div className={`${styles.rowIcon} ${styles.rowIconPending}`}>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        receipt_long
                      </span>
                    </div>
                    <div className={styles.rowCopy}>
                      <p className={styles.rowTitle}>AWS Hosting</p>
                      <p className={styles.rowMeta}>Pending matching receipt</p>
                    </div>
                  </div>
                  <div className={styles.amountBlock}>
                    <p className={styles.amount}>$342.10</p>
                    <p className={styles.rowMeta}>Oct 12, 2023</p>
                  </div>
                </div>

                <div className={styles.pendingRow}>
                  <div className={styles.rowLeft}>
                    <div className={`${styles.rowIcon} ${styles.rowIconPending}`}>
                      <span className="material-symbols-outlined" aria-hidden="true">
                        receipt_long
                      </span>
                    </div>
                    <div className={styles.rowCopy}>
                      <p className={styles.rowTitle}>Stripe Processing Fee</p>
                      <p className={styles.rowMeta}>Pending matching receipt</p>
                    </div>
                  </div>
                  <div className={styles.amountBlock}>
                    <p className={styles.amount}>$45.00</p>
                    <p className={styles.rowMeta}>Oct 10, 2023</p>
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.sideCards}>
              <div className={styles.featureCard}>
                <div className={styles.featureWatermark} aria-hidden="true">
                  <span className="material-symbols-outlined">all_match</span>
                </div>
                <h4 className={styles.featureTitle}>Automated Matching</h4>
                <p className={styles.featureCopy}>
                  Our semantic engine reads your receipts and bank feeds, pairing them automatically
                  based on date, amount, and vendor.
                </p>
              </div>
              <div className={styles.securityCard} id="security">
                <div className={styles.securityHeading}>
                  <span className="material-symbols-outlined" aria-hidden="true">
                    lock
                  </span>
                  <h4 className={styles.securityTitle}>Bank-Grade Security</h4>
                </div>
                <p className={styles.securityCopy}>
                  Read-only access to your financial data. We never move your money or store your
                  banking credentials.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer} id="privacy">
        <div className={styles.footerInner}>
          <div className={styles.footerBrand}>
            <span className={styles.footerName}>Ledgerwick</span>
            <span className={styles.footerYear}>© 2023</span>
          </div>
          <div className={styles.footerLinks}>
            <a className={styles.footerLink} href="#product">
              Product
            </a>
            <a className={styles.footerLink} href="#privacy">
              Privacy
            </a>
            <a className={styles.footerLink} href="#security">
              Security
            </a>
            <a className={styles.footerLink} href="#privacy">
              Contact
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
