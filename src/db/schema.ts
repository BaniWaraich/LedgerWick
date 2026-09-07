/**
 * Database schema.
 *
 * Implements docs/domain-model.md. Names follow docs/glossary.md; states follow
 * docs/state-machines.md. If you need a concept that is not here, add it to the domain
 * model first.
 *
 * Two rules run through the whole file:
 *
 * 1. Every workspace-scoped table carries `workspaceId`. Isolation is enforced in the
 *    application layer (docs/architecture.md §5.2), so the column has to be present for
 *    the data access layer to filter on.
 * 2. Domain invariants are database constraints, not conventions (docs/architecture.md
 *    §2.6). Where a rule can be an index, it is one.
 *
 * Money is stored as integer minor units (paise, cents) with an explicit currency, never
 * as a float. The balance equation adds thousands of these together and must be exact.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */
/* Values come from docs/state-machines.md. Do not add one without adding it there. */

export const statementStateEnum = pgEnum("statement_state", [
  "UPLOADING",
  "IDENTIFYING",
  "PARSING",
  "VALIDATING",
  "COMPLETED",
  "FAILED",
]);

export const validationOutcomeEnum = pgEnum("validation_outcome", ["VALID", "DISCREPANCY"]);

export const requirementStateEnum = pgEnum("requirement_state", [
  "IDENTIFIED",
  "SEARCHING",
  "EVALUATING",
  "NEEDS_REVIEW",
  "NOT_FOUND",
  "RESOLVED",
  "BLOCKED",
  "FAILED",
]);

export const resolutionMethodEnum = pgEnum("resolution_method", [
  "AUTO_RETRIEVED",
  "AUTO_MATCHED",
  "USER_CONFIRMED",
  "USER_LINKED",
  "NOT_REQUIRED",
]);

export const documentStateEnum = pgEnum("document_state", [
  "STORED",
  "EXTRACTING",
  "CLASSIFYING",
  "EXTRACTED",
  "UNREADABLE",
  "NOT_AN_INVOICE",
]);

/** Three-valued on purpose: uncertainty is not a negative. docs/state-machines.md §3. */
export const classificationEnum = pgEnum("classification", [
  "IS_INVOICE",
  "UNCERTAIN",
  "IS_NOT_INVOICE",
]);

export const documentSourceEnum = pgEnum("document_source", ["GMAIL", "MANUAL_UPLOAD"]);

export const runStateEnum = pgEnum("run_state", ["RUNNING", "COMPLETED", "FAILED"]);

export const directionEnum = pgEnum("direction", ["DEBIT", "CREDIT"]);

/* ------------------------------------------------------------------ identity */

/**
 * Mirrors the authenticated user. `id` is the Supabase Auth user id.
 *
 * Kept as its own table rather than referencing `auth.users` directly so that the schema
 * stands alone — tests run against a bare Postgres with no auth schema present.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** The authorization boundary. Everything below belongs to exactly one of these. */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspaces_owner_idx").on(t.ownerId)],
);

/* ------------------------------------------------------------------ accounts and statements */

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bankName: text("bank_name").notNull(),
    /** As printed on the statement — often masked. Identity is scoped to the workspace. */
    accountIdentifier: text("account_identifier").notNull(),
    accountType: text("account_type"),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The lookup in upload-statement Step 3a never crosses a workspace, so neither does
    // this uniqueness.
    uniqueIndex("bank_accounts_identity_idx").on(t.workspaceId, t.bankName, t.accountIdentifier),
  ],
);

/**
 * One uploaded file.
 *
 * `periodStart`/`periodEnd` are nullable only because they are unknown until the file is
 * identified; a statement cannot reach COMPLETED without them (upload-statement Step 3),
 * since Statement Coverage is derived from these columns.
 */
export const bankStatements = pgTable(
  "bank_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** Null until Step 3a binds the statement to an account. */
    bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id, {
      onDelete: "restrict",
    }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    storageRef: text("storage_ref").notNull(),
    state: statementStateEnum("state").notNull().default("UPLOADING"),
    validationOutcome: validationOutcomeEnum("validation_outcome"),
    failureReason: text("failure_reason"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    openingBalance: bigint("opening_balance", { mode: "bigint" }),
    closingBalance: bigint("closing_balance", { mode: "bigint" }),
    totalCredits: bigint("total_credits", { mode: "bigint" }),
    totalDebits: bigint("total_debits", { mode: "bigint" }),
    lineCount: integer("line_count"),
    /** The column mapping a model inferred, kept for debugging a bad parse. ADR 0003. */
    columnMapping: jsonb("column_mapping"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bank_statements_workspace_idx").on(t.workspaceId),
    index("bank_statements_coverage_idx").on(t.bankAccountId, t.periodStart, t.periodEnd),
  ],
);

/**
 * One row exactly as extracted from one statement. Immutable evidence.
 *
 * Overlapping statements produce two of these for one payment; both point at the same
 * canonical transaction.
 */
export const statementLines = pgTable(
  "statement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    statementId: uuid("statement_id")
      .notNull()
      .references(() => bankStatements.id, { onDelete: "cascade" }),
    rowIndex: integer("row_index").notNull(),
    valueDate: date("value_date").notNull(),
    description: text("description").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    direction: directionEnum("direction").notNull(),
    balanceMinor: bigint("balance_minor", { mode: "bigint" }),
    canonicalTransactionId: uuid("canonical_transaction_id").references(
      () => canonicalTransactions.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    uniqueIndex("statement_lines_row_idx").on(t.statementId, t.rowIndex),
    index("statement_lines_canonical_idx").on(t.canonicalTransactionId),
  ],
);

/**
 * The business's single record of one financial movement.
 *
 * Everything downstream references this, never a statement line.
 */
export const canonicalTransactions = pgTable(
  "canonical_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    valueDate: date("value_date").notNull(),
    /** Always positive; `direction` carries the sign. */
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    direction: directionEnum("direction").notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    /** Case, whitespace and punctuation normalized. Formatting only — never interpreted. */
    descriptionNormalized: text("description_normalized").notNull(),
    /**
     * Distinguishes two legitimately identical payments on one day from the same payment
     * seen in two overlapping statements. upload-statement Step 5a.
     */
    occurrenceIndex: integer("occurrence_index").notNull().default(0),
    /** A bank-supplied reference or UTR. When present it alone establishes identity. */
    externalReference: text("external_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The dedup rule, as a constraint. A second upload of the same statement collides
    // here rather than silently creating duplicate transactions.
    uniqueIndex("canonical_transactions_identity_idx").on(
      t.bankAccountId,
      t.valueDate,
      t.amountMinor,
      t.direction,
      t.descriptionNormalized,
      t.occurrenceIndex,
    ),
    // When the bank gives a reference, it wins outright.
    uniqueIndex("canonical_transactions_reference_idx")
      .on(t.bankAccountId, t.externalReference)
      .where(sql`external_reference is not null`),
    index("canonical_transactions_workspace_date_idx").on(t.workspaceId, t.valueDate),
  ],
);

/* ------------------------------------------------------------------ vendors */

export const vendors = pgTable(
  "vendors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("vendors_workspace_idx").on(t.workspaceId)],
);

/**
 * An alternate representation of a vendor.
 *
 * `confirmed` is the line between a user's decision and a model's guess: only a confirmed
 * alias is Business Knowledge (docs/architecture.md §11). Inferred aliases may widen a
 * search within the run that produced them and are not persisted as fact.
 */
export const vendorAliases = pgTable(
  "vendor_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    aliasNormalized: text("alias_normalized").notNull(),
    confirmed: boolean("confirmed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("vendor_aliases_identity_idx").on(t.workspaceId, t.aliasNormalized)],
);

/* ------------------------------------------------------------------ documents and invoices */

/**
 * Any file offered as evidence — invoice, receipt, payment confirmation.
 *
 * Every file is one of these first. Only some become invoices (docs/domain-model.md §5.1).
 */
export const supportingDocuments = pgTable(
  "supporting_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    storageRef: text("storage_ref").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    source: documentSourceEnum("source").notNull(),
    state: documentStateEnum("state").notNull().default("STORED"),
    classification: classificationEnum("classification"),
    /** Provenance for a retrieved document: account, message, attachment. */
    sourceMetadata: jsonb("source_metadata"),
    /** Set when the document resolves a requirement without being classified an invoice. */
    canonicalTransactionId: uuid("canonical_transaction_id").references(
      () => canonicalTransactions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("supporting_documents_workspace_idx").on(t.workspaceId),
    index("supporting_documents_transaction_idx").on(t.canonicalTransactionId),
  ],
);

/**
 * A document classified and extracted as a charge from a vendor.
 *
 * The 1:1 rule with transactions is enforced below, and constrains extracted invoices
 * only — a transaction may hold several supporting documents but at most one invoice.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    vendorId: uuid("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    totalMinor: bigint("total_minor", { mode: "bigint" }),
    currency: text("currency"),
    taxMinor: bigint("tax_minor", { mode: "bigint" }),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }),
    /** Domain invariant 8: an invoice links to at most one transaction. */
    canonicalTransactionId: uuid("canonical_transaction_id").references(
      () => canonicalTransactions.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Domain invariant 9: a transaction has at most one invoice. Partial, because many
    // invoices are legitimately unlinked and NULLs must not collide.
    uniqueIndex("invoices_transaction_idx")
      .on(t.canonicalTransactionId)
      .where(sql`canonical_transaction_id is not null`),
    index("invoices_workspace_idx").on(t.workspaceId),
  ],
);

/** An invoice may be represented by several files. */
export const invoiceDocuments = pgTable(
  "invoice_documents",
  {
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => supportingDocuments.id, { onDelete: "cascade" }),
    isPrimary: boolean("is_primary").notNull().default(false),
  },
  (t) => [uniqueIndex("invoice_documents_pk").on(t.invoiceId, t.documentId)],
);

/* ------------------------------------------------------------------ reconciliation */

/**
 * The determination that a transaction should have a supporting document.
 *
 * Persisted, not derived: retrieval works against it and must be resumable, and the user
 * acts on it. docs/domain-model.md §3.12.
 */
export const invoiceRequirements = pgTable(
  "invoice_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalTransactionId: uuid("canonical_transaction_id")
      .notNull()
      .references(() => canonicalTransactions.id, { onDelete: "cascade" }),
    state: requirementStateEnum("state").notNull().default("IDENTIFIED"),
    /** Why a document is believed to be required, in the user's language. */
    reason: text("reason"),
    resolutionMethod: resolutionMethodEnum("resolution_method"),
    resolvedDocumentId: uuid("resolved_document_id").references(() => supportingDocuments.id, {
      onDelete: "set null",
    }),
    /** Candidates the user rejected, so a later run does not offer them again. */
    rejectedDocumentIds: jsonb("rejected_document_ids").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one requirement per transaction (docs/domain-model.md invariant 16).
    uniqueIndex("invoice_requirements_transaction_idx").on(t.canonicalTransactionId),
    index("invoice_requirements_queue_idx").on(t.workspaceId, t.state),
  ],
);

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    state: runStateEnum("state").notNull().default("RUNNING"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    coverageStart: date("coverage_start"),
    coverageEnd: date("coverage_end"),
    transactionsProcessed: integer("transactions_processed"),
    documentsRequired: integer("documents_required"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reconciliation_runs_workspace_idx").on(t.workspaceId, t.startedAt)],
);

/* ------------------------------------------------------------------ knowledge */

/**
 * Durable fact learned from a user's confirmed decision. Never written from an
 * unconfirmed inference (docs/domain-model.md §3.14).
 */
export const businessKnowledge = pgTable(
  "business_knowledge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("business_knowledge_identity_idx").on(t.workspaceId, t.kind, t.key)],
);

/**
 * Persisted because the user may be away when it is raised and must be able to answer
 * later. The run does not stall waiting (docs/architecture.md §12C).
 */
export const clarificationQuestions = pgTable(
  "clarification_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    canonicalTransactionId: uuid("canonical_transaction_id").references(
      () => canonicalTransactions.id,
      { onDelete: "cascade" },
    ),
    question: text("question").notNull(),
    options: jsonb("options"),
    answer: text("answer"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("clarification_questions_open_idx").on(t.workspaceId, t.answeredAt)],
);
