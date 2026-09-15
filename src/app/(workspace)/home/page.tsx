/**
 * The workspace home.
 *
 * Still close to empty: the reconciliation surfaces the wireframe shows belong to features
 * D onwards, and building them here as placeholders would be inventing product. What it
 * offers is the one thing that now works end to end — getting statements in.
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
        Start by uploading your bank statements. Connecting a mailbox arrives with a later feature.
      </p>
      <Link className={styles.action} href="/statements/upload">
        Upload statements
      </Link>
    </header>
  );
}
