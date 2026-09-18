/**
 * The workspace home.
 *
 * Still close to empty: the reconciliation surfaces the wireframe shows belong to the
 * features that own them, and building them here as placeholders would be inventing
 * product. What it offers is the two things that now work end to end — getting statements
 * in, and seeing what they turned out to need documents for.
 */

import Link from "next/link";

import { requireScope } from "../../../auth/workspace";
import styles from "./page.module.css";

export default async function HomePage() {
  // The layout has already resolved this; asking again is memoized by `cache`, and keeps
  // the page honest about what it depends on.
  await requireScope();

  return (
    <header className={styles.header}>
      <h1 className={styles.title}>Welcome back</h1>
      <p className={styles.subtitle}>
        Upload your bank statements and we&rsquo;ll work out which payments need a document.
        Connecting a mailbox arrives with a later feature.
      </p>
      <Link className={styles.action} href="/statements/upload">
        Upload statements
      </Link>
      <Link className={styles.secondaryAction} href="/reconciliation">
        See what needs invoices
      </Link>
    </header>
  );
}
