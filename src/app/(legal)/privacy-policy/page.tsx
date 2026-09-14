/**
 * Privacy Policy.
 *
 * Written against what the system actually does, per docs/architecture.md §19, §12.4 and
 * docs/workflows/connect-gmail.md §6. Where a commitment appears here it is one the specs
 * already require of the code — the two must not drift, so a change to either is a change
 * to both.
 *
 * §4 carries the Google API Services User Data Policy disclosure, including Limited Use,
 * which OAuth verification for the Restricted `gmail.readonly` scope requires verbatim.
 */

import type { Metadata } from "next";

import styles from "../legal.module.css";

export const metadata: Metadata = {
  title: "Privacy Policy · Ledgerwick",
  description:
    "How Ledgerwick collects, uses, stores and protects your data, including data accessed from Google accounts.",
  alternates: { canonical: "https://www.ledgerwick.com/privacy-policy" },
};

const EFFECTIVE = "14 September 2026";

export default function PrivacyPolicyPage() {
  return (
    <article>
      <h1 className={styles.title}>Privacy Policy</h1>
      <p className={styles.meta}>
        Effective {EFFECTIVE} · Last updated {EFFECTIVE}
      </p>

      <p className={styles.lede}>
        Ledgerwick helps a business owner work out which of their bank payments lack a supporting
        invoice, and find those invoices. Doing that means handling financial records and, if you
        choose to connect it, the contents of your email. This policy explains exactly what we
        access, what we store, what we never do, and how you get any of it back or deleted.
      </p>

      <nav className={styles.toc} aria-label="Contents">
        <p className={styles.tocTitle}>Contents</p>
        <ol className={styles.tocList}>
          <li>
            <a href="#who-we-are">Who we are</a>
          </li>
          <li>
            <a href="#what-we-collect">What we collect</a>
          </li>
          <li>
            <a href="#how-we-use-it">How we use it</a>
          </li>
          <li>
            <a href="#google-user-data">Google user data and Limited Use</a>
          </li>
          <li>
            <a href="#ai">Automated processing and AI</a>
          </li>
          <li>
            <a href="#legal-bases">Legal bases for processing</a>
          </li>
          <li>
            <a href="#sharing">Who else processes your data</a>
          </li>
          <li>
            <a href="#security">Security</a>
          </li>
          <li>
            <a href="#retention">Retention and deletion</a>
          </li>
          <li>
            <a href="#your-rights">Your rights</a>
          </li>
          <li>
            <a href="#transfers">International transfers</a>
          </li>
          <li>
            <a href="#children">Children</a>
          </li>
          <li>
            <a href="#changes">Changes to this policy</a>
          </li>
          <li>
            <a href="#contact">Contact and grievances</a>
          </li>
        </ol>
      </nav>

      <section className={styles.section} id="who-we-are">
        <h2 className={styles.sectionTitle}>1. Who we are</h2>
        <p>
          Ledgerwick is operated by <strong>Bani Waraich</strong>, an individual in India, under the
          trade name Ledgerwick. For the purposes of the Digital Personal Data Protection Act, 2023
          we are the <strong>Data Fiduciary</strong> for the personal data described here; under the
          GDPR we are the <strong>data controller</strong>.
        </p>
        <p>
          You can reach us about anything in this policy at{" "}
          <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a>.
        </p>
      </section>

      <section className={styles.section} id="what-we-collect">
        <h2 className={styles.sectionTitle}>2. What we collect</h2>

        <h3 className={styles.subTitle}>Account information</h3>
        <p>
          You sign in with Google. We receive your name, email address and Google profile
          identifier. We never receive or store your Google password. Signing in requests{" "}
          <strong>profile and email access only</strong> — no access to your mail is requested at
          sign-up.
        </p>

        <h3 className={styles.subTitle}>Financial records you provide</h3>
        <p>
          Bank statements you upload, and everything derived from them: the original file, the
          individual transaction lines, the consolidated record of each payment, the bank and
          account details printed on the statement, and the period the statement covers. Invoices
          and receipts you upload are stored as you provided them.
        </p>

        <h3 className={styles.subTitle}>Email data, only if you connect a mailbox</h3>
        <p>
          Connecting a Google account is a separate, optional step taken inside the product. If you
          take it, we access that mailbox in order to locate invoices and receipts relating to your
          transactions. Section 4 sets out precisely what this covers.
        </p>

        <h3 className={styles.subTitle}>Information you generate by using the product</h3>
        <p>
          Decisions you confirm — that a document matches a payment, that a payment needs no
          document, that a particular vendor never invoices you — are stored so the system stops
          asking you the same question. We also keep basic operational logs needed to run and secure
          the service.
        </p>

        <h3 className={styles.subTitle}>What we do not collect</h3>
        <p>
          We do not ask for, receive or store your banking credentials or card details. We have no
          connection to your bank and cannot move money. We do not use advertising trackers or sell
          data to anyone, for any purpose.
        </p>
      </section>

      <section className={styles.section} id="how-we-use-it">
        <h2 className={styles.sectionTitle}>3. How we use it</h2>
        <p>We use your data to do the thing you asked us to do, and for nothing else:</p>
        <ul>
          <li>read your bank statements and identify each payment;</li>
          <li>work out which payments are likely to need a supporting invoice;</li>
          <li>search any mailbox you have connected for the documents that support them;</li>
          <li>match documents to payments and show you the evidence for each match;</li>
          <li>produce the reconciliation report and export you download;</li>
          <li>keep your account secure and the service running;</li>
          <li>reply to you when you contact us.</li>
        </ul>
        <p>We do not use your data to build advertising profiles, and we do not sell or rent it.</p>
      </section>

      <section className={styles.section} id="google-user-data">
        <h2 className={styles.sectionTitle}>4. Google user data and Limited Use</h2>

        <div className={styles.callout}>
          <p>
            Ledgerwick&rsquo;s use and transfer of information received from Google APIs to any
            other app will adhere to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </p>
        </div>

        <h3 className={styles.subTitle}>What we request, and when</h3>
        <p>
          We request the <strong>gmail.readonly</strong> scope. It is requested{" "}
          <strong>incrementally</strong> — only at the moment you choose to connect a mailbox, never
          when you create your account. If you never connect a mailbox, we never hold this
          permission. The scope is read-only: Ledgerwick cannot send, modify, delete or label mail,
          and never attempts to.
        </p>

        <h3 className={styles.subTitle}>What we actually read</h3>
        <p>
          Searching your mailbox uses <strong>message metadata only</strong> — sender, recipient,
          subject, date, and attachment filenames. When that metadata indicates a message is likely
          to carry an invoice for one of your payments, we download the <strong>attachment</strong>{" "}
          from that specific message.
        </p>
        <p>
          <strong>We do not read, store or process the body text of your emails.</strong> This is
          enforced in the code, not merely promised: mail access is confined to a single module, and
          the search path is tested to prove it never requests full message content.
        </p>

        <h3 className={styles.subTitle}>What we keep</h3>
        <p>
          We store the attachments we retrieve, because a reconciliation has to be defensible later
          and re-fetching from Gmail every time would mean holding broader access for longer. We
          also keep the limited message metadata needed to show you why a document was suggested —
          who sent it, when, and the subject line. Message bodies are never persisted.
        </p>

        <h3 className={styles.subTitle}>Limited Use commitments</h3>
        <ul>
          <li>
            Google user data is used <strong>only</strong> to provide and improve the
            invoice-finding features you are using.
          </li>
          <li>
            We do not transfer Google user data to others, except as necessary to provide the
            service (section 7), for security or to comply with the law.
          </li>
          <li>
            We do <strong>not</strong> use Google user data for advertising, and we never sell it.
          </li>
          <li>
            We do <strong>not</strong> allow humans to read your Google user data, except with your
            explicit consent for a specific issue you have raised, where necessary for security or
            to comply with the law, or on data that has been aggregated and anonymised.
          </li>
          <li>
            We do <strong>not</strong> use Google user data to develop, improve or train generalised
            artificial intelligence or machine-learning models. See section 5.
          </li>
        </ul>

        <h3 className={styles.subTitle}>Disconnecting</h3>
        <p>
          You can disconnect any mailbox at any time from inside Ledgerwick. Disconnecting revokes
          our access with Google and deletes the stored credentials. Documents already retrieved and
          matched stay in your workspace, because they are now part of your financial record — you
          can delete those separately. You can also revoke access directly at{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
          >
            myaccount.google.com/permissions
          </a>
          .
        </p>
      </section>

      <section className={styles.section} id="ai">
        <h2 className={styles.sectionTitle}>5. Automated processing and AI</h2>
        <p>
          Ledgerwick uses automated systems, including third-party AI models, to read the structure
          of a bank statement, to read the contents of an invoice, and to judge whether a document
          relates to a payment. This is how the product works, and we would rather be precise than
          vague about it.
        </p>
        <p>What is sent to an AI model:</p>
        <ul>
          <li>bank statement files you upload, in order to identify their columns and values;</li>
          <li>
            invoice and receipt documents, in order to extract vendor, amount, date and number;
          </li>
          <li>
            for mailbox search, only message <strong>metadata</strong> — sender, subject, date,
            attachment filename — and the attachment itself.
          </li>
        </ul>
        <p>What is never sent to an AI model:</p>
        <ul>
          <li>the body text of your emails;</li>
          <li>your access tokens or any other credential.</li>
        </ul>
        <p>
          <strong>
            Your data is never used to train, fine-tune or improve any AI model, ours or anyone
            else&rsquo;s.
          </strong>{" "}
          We contract with providers on terms that prohibit training on our data and require prompt
          deletion after processing. We have deliberately not named a specific model provider in
          this policy while that choice is still being evaluated; the commitments in this section
          apply to whichever provider we use, and we will update this policy if the position changes
          in any way that affects you.
        </p>
        <p>
          An AI model never makes a final decision about your records. It proposes; the system
          applies deterministic rules; and where the evidence is not strong enough, the question
          comes to you. You can always see the evidence behind any match and overrule it.
        </p>
      </section>

      <section className={styles.section} id="legal-bases">
        <h2 className={styles.sectionTitle}>6. Legal bases for processing</h2>
        <p>
          Under the DPDP Act we process your personal data on the basis of the{" "}
          <strong>consent</strong> you give when you create an account and, separately, when you
          connect a mailbox. Where the GDPR applies to you, our legal bases are:
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Legal basis</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Providing the reconciliation service to you</td>
                <td>Performance of a contract (Art. 6(1)(b))</td>
              </tr>
              <tr>
                <td>Accessing a mailbox you connect</td>
                <td>Consent (Art. 6(1)(a)), withdrawable at any time</td>
              </tr>
              <tr>
                <td>Keeping the service secure and available</td>
                <td>Legitimate interests (Art. 6(1)(f))</td>
              </tr>
              <tr>
                <td>Meeting legal and tax obligations</td>
                <td>Legal obligation (Art. 6(1)(c))</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Withdrawing consent for mailbox access does not affect processing already carried out, and
          does not require you to close your account.
        </p>
      </section>

      <section className={styles.section} id="sharing">
        <h2 className={styles.sectionTitle}>7. Who else processes your data</h2>
        <p>
          We keep the list short on purpose. Each of these is a processor acting on our
          instructions, under contract:
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>What it does</th>
                <th>Where</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Vercel</td>
                <td>Hosts the application and stores your documents in private storage</td>
                <td>United States</td>
              </tr>
              <tr>
                <td>Neon</td>
                <td>Hosts the database holding your account and financial records</td>
                <td>United States</td>
              </tr>
              <tr>
                <td>Google</td>
                <td>Sign-in, and mailbox access if you connect one</td>
                <td>Global</td>
              </tr>
              <tr>
                <td>AI model provider</td>
                <td>
                  Reads statement structure and document contents, under a no-training agreement
                  (section 5)
                </td>
                <td>United States</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          We may also disclose data if the law requires it, or to protect our rights or
          someone&rsquo;s safety. If Ledgerwick is ever sold or transferred, we will tell you before
          your data moves, and this policy will continue to apply until you are given a new one.
        </p>
      </section>

      <section className={styles.section} id="security">
        <h2 className={styles.sectionTitle}>8. Security</h2>
        <ul>
          <li>
            <strong>Your documents are private.</strong> Files are stored in private object storage
            with no public address. There is no link that grants access to a document; every file is
            served only after we have checked your session and your right to that specific
            workspace.
          </li>
          <li>
            <strong>Workspaces are isolated.</strong> Every query for your data is scoped to your
            workspace at the point it is written, and we maintain automated tests that deliberately
            attempt cross-workspace access and require it to fail.
          </li>
          <li>
            <strong>Credentials are protected.</strong> Google tokens are encrypted at rest, are
            never written to logs or error reports, are never exposed to the browser, and are never
            sent to an AI model.
          </li>
          <li>
            <strong>Everything is encrypted in transit</strong> over TLS.
          </li>
        </ul>
        <p>
          No system is perfectly secure. If a breach affects your personal data we will notify you
          and the relevant authorities as required by the DPDP Act and, where applicable, the GDPR.
        </p>
      </section>

      <section className={styles.section} id="retention">
        <h2 className={styles.sectionTitle}>9. Retention and deletion</h2>
        <p>
          We keep your financial records for as long as your account is open, because a
          reconciliation is a record you may need to produce years later. You can delete individual
          documents and statements at any time from within the product.
        </p>
        <p>
          Ask us to close your account and we will delete your personal data, your documents and
          your financial records within <strong>30 days</strong>, except anything we are required to
          retain by law. Disconnected mailbox credentials are deleted immediately, not at the end of
          any retention period.
        </p>
      </section>

      <section className={styles.section} id="your-rights">
        <h2 className={styles.sectionTitle}>10. Your rights</h2>
        <p>Whatever jurisdiction you are in, you can ask us to:</p>
        <ul>
          <li>tell you what data we hold about you and why;</li>
          <li>give you a copy of it in a portable form;</li>
          <li>correct anything inaccurate or incomplete;</li>
          <li>delete it;</li>
          <li>stop or restrict a particular use of it;</li>
          <li>withdraw a consent you previously gave, including mailbox access;</li>
          <li>nominate someone to exercise these rights if you die or become incapacitated.</li>
        </ul>
        <p>
          Email <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a> and we will respond
          within 30 days. There is no charge.
        </p>
        <p>
          If you are unhappy with our response, you may complain to the Data Protection Board of
          India, or — if the GDPR applies to you — to your local supervisory authority.
        </p>
      </section>

      <section className={styles.section} id="transfers">
        <h2 className={styles.sectionTitle}>11. International transfers</h2>
        <p>
          Our infrastructure providers are based in the United States, so your data is processed
          outside India and outside the European Economic Area. Where the GDPR applies, these
          transfers are covered by Standard Contractual Clauses with each provider. Transfers from
          India are made in accordance with the DPDP Act.
        </p>
      </section>

      <section className={styles.section} id="children">
        <h2 className={styles.sectionTitle}>12. Children</h2>
        <p>
          Ledgerwick is a tool for businesses and is not directed at children. We do not knowingly
          collect data from anyone under 18. If you believe a child has given us personal data, tell
          us and we will delete it.
        </p>
      </section>

      <section className={styles.section} id="changes">
        <h2 className={styles.sectionTitle}>13. Changes to this policy</h2>
        <p>
          If we change this policy we will update the date at the top. For any change that
          materially affects how we handle your data — particularly anything touching Google user
          data — we will tell you by email before it takes effect, and where the law requires it we
          will ask for your consent again.
        </p>
      </section>

      <section className={styles.section} id="contact">
        <h2 className={styles.sectionTitle}>14. Contact and grievances</h2>
        <p>
          Bani Waraich, an individual in India, operating under the trade name Ledgerwick.
          <br />
          Email: <a href="mailto:waraichbani@gmail.com">waraichbani@gmail.com</a>
        </p>
        <p>
          The same address serves as our grievance contact under the DPDP Act. Write to us first —
          we would rather fix a problem than have you take it elsewhere — but your right to complain
          to a regulator is not conditional on doing so.
        </p>
      </section>
    </article>
  );
}
