/**
 * Terms & Conditions.
 *
 * Two things here are product facts rather than boilerplate, and should change only when
 * the product does: §4 (Ledgerwick proposes, you decide — docs/architecture.md §2.3) and
 * §8 (the service is pre-release). Both are load-bearing, in that the disclaimers in §10
 * rest on them.
 */

import type { Metadata } from "next";

import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Terms & Conditions · Ledgerwick",
  description:
    "The terms on which Ledgerwick is provided, including your responsibilities, our disclaimers, and the governing law.",
  alternates: { canonical: "https://www.ledgerwick.com/terms-and-conditions" },
};

const EFFECTIVE = "14 September 2026";

export default function TermsPage() {
  return (
    <article>
      <h1 className={styles.title}>Terms &amp; Conditions</h1>
      <p className={styles.meta}>
        Effective {EFFECTIVE} · Last updated {EFFECTIVE}
      </p>

      <p className={styles.lede}>
        These terms are the agreement between you and Ledgerwick. They cover what the service does,
        what we ask of you, and what we are and are not responsible for. Using Ledgerwick means you
        accept them.
      </p>

      <nav className={styles.toc} aria-label="Contents">
        <p className={styles.tocTitle}>Contents</p>
        <ol className={styles.tocList}>
          <li>
            <a href="#who-we-are">Who we are</a>
          </li>
          <li>
            <a href="#eligibility">Eligibility and your account</a>
          </li>
          <li>
            <a href="#service">What the service does</a>
          </li>
          <li>
            <a href="#not-advice">Ledgerwick proposes, you decide</a>
          </li>
          <li>
            <a href="#your-responsibilities">Your responsibilities</a>
          </li>
          <li>
            <a href="#acceptable-use">Acceptable use</a>
          </li>
          <li>
            <a href="#third-parties">Third-party services</a>
          </li>
          <li>
            <a href="#availability">Availability and changes</a>
          </li>
          <li>
            <a href="#ip">Ownership</a>
          </li>
          <li>
            <a href="#disclaimers">Disclaimers</a>
          </li>
          <li>
            <a href="#liability">Limitation of liability</a>
          </li>
          <li>
            <a href="#termination">Ending this agreement</a>
          </li>
          <li>
            <a href="#law">Governing law</a>
          </li>
          <li>
            <a href="#changes">Changes to these terms</a>
          </li>
          <li>
            <a href="#contact">Contact</a>
          </li>
        </ol>
      </nav>

      <section className={styles.section} id="who-we-are">
        <h2 className={styles.sectionTitle}>1. Who we are</h2>
        <p>
          Ledgerwick is operated by <strong>Bani Waraich</strong>, a sole proprietor trading as
          Ledgerwick, based in India (&ldquo;Ledgerwick&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;).
          &ldquo;You&rdquo; means the person or business using the service.
        </p>
      </section>

      <section className={styles.section} id="eligibility">
        <h2 className={styles.sectionTitle}>2. Eligibility and your account</h2>
        <p>
          You must be at least 18 and able to enter a binding contract. If you use Ledgerwick for a
          business, you confirm you are authorised to accept these terms for it.
        </p>
        <p>
          You sign in with Google. You are responsible for keeping that Google account secure —
          anyone who controls it controls your Ledgerwick data. Tell us promptly if you think your
          account has been compromised.
        </p>
      </section>

      <section className={styles.section} id="service">
        <h2 className={styles.sectionTitle}>3. What the service does</h2>
        <p>
          Ledgerwick reads bank statements you upload, works out which payments are likely to need a
          supporting invoice, searches any mailbox you connect for those documents, matches what it
          finds, and produces a reconciliation you can export. Where it cannot decide, it asks you.
        </p>
        <p>
          Ledgerwick is read-only with respect to your financial life. It has no connection to your
          bank, holds no banking credentials, and cannot move money. Mailbox access, if you grant
          it, is read-only: we cannot send, alter or delete your mail.
        </p>
      </section>

      <section className={styles.section} id="not-advice">
        <h2 className={styles.sectionTitle}>4. Ledgerwick proposes, you decide</h2>
        <div className={styles.callout}>
          <p>
            <strong>
              Ledgerwick is not an accountant, and nothing it produces is accounting, tax, legal or
              financial advice.
            </strong>{" "}
            It is a tool that finds documents and suggests matches. Every output is a draft for you
            to check.
          </p>
        </div>
        <p>
          The service uses automated systems, including AI models, to interpret documents. These are
          good at finding candidates and poor at being certain. By design, Ledgerwick shows you the
          evidence behind every match and lets you overrule it, and it asks rather than guesses when
          the evidence is weak. That design only protects you if you use it.
        </p>
        <p>
          You are responsible for reviewing any reconciliation before relying on it, filing it, or
          giving it to an accountant or a tax authority. We do not warrant that every payment
          requiring documentation is identified, that every match is correct, or that any export is
          complete or fit for a statutory filing.
        </p>
      </section>

      <section className={styles.section} id="your-responsibilities">
        <h2 className={styles.sectionTitle}>5. Your responsibilities</h2>
        <ul>
          <li>
            You have the right to upload the statements and documents you upload, and to grant
            access to any mailbox you connect.
          </li>
          <li>
            Where those contain other people&rsquo;s personal data, you have a lawful basis for
            giving it to us to process on your behalf.
          </li>
          <li>You keep your own copies of anything you cannot afford to lose.</li>
          <li>You review the output before acting on it.</li>
        </ul>
      </section>

      <section className={styles.section} id="acceptable-use">
        <h2 className={styles.sectionTitle}>6. Acceptable use</h2>
        <p>Do not:</p>
        <ul>
          <li>use Ledgerwick for anything unlawful, or to process data you have no right to;</li>
          <li>try to access another user&rsquo;s workspace, account or documents;</li>
          <li>
            probe, scan or attack the service, or attempt to defeat its authorisation or isolation
            controls;
          </li>
          <li>
            scrape it, resell it, or run it as a service for others without our written agreement;
          </li>
          <li>upload malware, or deliberately overload the service.</li>
        </ul>
        <p>
          If you find a security vulnerability, please report it to{" "}
          <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a> rather than exploiting
          it. We will not pursue anyone who reports a genuine issue in good faith and gives us a
          reasonable chance to fix it.
        </p>
      </section>

      <section className={styles.section} id="third-parties">
        <h2 className={styles.sectionTitle}>7. Third-party services</h2>
        <p>
          Ledgerwick depends on services we do not control, including Google. Your use of a Google
          account remains subject to Google&rsquo;s own terms. If Google changes or withdraws access
          to its APIs, features that depend on them may change or stop working, and that is outside
          our control.
        </p>
        <p>
          How we handle data from Google accounts, including our Limited Use commitments, is set out
          in our <a href="/privacy-policy">Privacy Policy</a>.
        </p>
      </section>

      <section className={styles.section} id="availability">
        <h2 className={styles.sectionTitle}>8. Availability and changes</h2>
        <div className={styles.callout}>
          <p>
            <strong>Ledgerwick is a pre-release product under active development.</strong> Features
            may change, break or be withdrawn. We do not currently offer a service-level commitment,
            and you should not treat Ledgerwick as your only record of anything.
          </p>
        </div>
        <p>
          We aim to keep it available and to give notice before a change that would disrupt you, but
          we may modify, suspend or discontinue any part of the service. If we discontinue it
          entirely, we will give you a reasonable opportunity to export your data first.
        </p>
      </section>

      <section className={styles.section} id="ip">
        <h2 className={styles.sectionTitle}>9. Ownership</h2>
        <p>
          <strong>Your data stays yours.</strong> Statements, documents and reconciliations you
          create belong to you. You grant us only the permission we need to store and process them
          in order to run the service for you — nothing broader, and nothing that survives your
          account.
        </p>
        <p>
          The software, design and the Ledgerwick name remain ours. These terms grant you a
          personal, non-exclusive, non-transferable right to use the service, and nothing more.
        </p>
      </section>

      <section className={styles.section} id="disclaimers">
        <h2 className={styles.sectionTitle}>10. Disclaimers</h2>
        <p>
          To the fullest extent the law allows, Ledgerwick is provided{" "}
          <strong>&ldquo;as is&rdquo; and &ldquo;as available&rdquo;</strong>, without warranties of
          any kind, express or implied, including merchantability, fitness for a particular purpose
          and non-infringement.
        </p>
        <p>
          We do not warrant that the service will be uninterrupted or error-free, that automated
          matching will be accurate or complete, or that it will identify every payment needing a
          document. Section 4 explains why, and what to do about it.
        </p>
        <p>Nothing here excludes liability that cannot lawfully be excluded.</p>
      </section>

      <section className={styles.section} id="liability">
        <h2 className={styles.sectionTitle}>11. Limitation of liability</h2>
        <p>
          To the fullest extent the law allows, we are not liable for indirect, incidental, special
          or consequential loss, or for lost profits, lost revenue, lost data, or any tax penalty,
          interest or professional fee arising from your use of the service.
        </p>
        <p>
          Our total liability arising out of or relating to these terms is limited to the greater of
          the amount you paid us in the twelve months before the claim, or <strong>₹10,000</strong>.
        </p>
        <p>
          These limits do not apply to liability for death or personal injury caused by negligence,
          for fraud, or for anything else that cannot lawfully be limited.
        </p>
      </section>

      <section className={styles.section} id="termination">
        <h2 className={styles.sectionTitle}>12. Ending this agreement</h2>
        <p>
          You may stop using Ledgerwick and ask us to close your account at any time, by emailing{" "}
          <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a>. We delete your data as
          described in the <a href="/privacy-policy">Privacy Policy</a>.
        </p>
        <p>
          We may suspend or close your account if you materially breach these terms, or if we are
          required to by law. Except where the breach makes it inappropriate, we will tell you first
          and give you a chance to export your data.
        </p>
      </section>

      <section className={styles.section} id="law">
        <h2 className={styles.sectionTitle}>13. Governing law</h2>
        <p>
          These terms are governed by the laws of India. The courts of competent jurisdiction in
          India have exclusive jurisdiction over any dispute, and you and we both submit to them.
        </p>
        <p>
          If any provision is found unenforceable, the rest remains in force. Our not enforcing a
          provision is not a waiver of it.
        </p>
      </section>

      <section className={styles.section} id="changes">
        <h2 className={styles.sectionTitle}>14. Changes to these terms</h2>
        <p>
          We may update these terms. The date at the top will change, and for material changes we
          will email you before they take effect. Continuing to use Ledgerwick after that means you
          accept the new terms; if you do not, stop using the service and ask us to close your
          account.
        </p>
      </section>

      <section className={styles.section} id="contact">
        <h2 className={styles.sectionTitle}>15. Contact</h2>
        <p>
          Bani Waraich, sole proprietor, trading as Ledgerwick.
          <br />
          Email: <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a>
        </p>
      </section>
    </article>
  );
}
