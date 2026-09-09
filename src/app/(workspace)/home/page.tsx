/**
 * The workspace home.
 *
 * Deliberately close to empty: the reconciliation surfaces the wireframe shows belong to
 * features C onwards, and building them here as placeholders would be inventing product.
 * What this page proves is that the shell resolves a workspace from the session.
 */

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
        Your workspace is ready. Connecting a mailbox and uploading statements arrive with the next
        features.
      </p>
    </header>
  );
}
