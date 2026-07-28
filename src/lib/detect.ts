/**
 * Capability detection.
 *
 * Vercel's API hands back env var *keys* (never values), and GitHub gives us
 * package.json. Between the two we can infer most of what the grid asks for
 * without anyone typing a thing. Every match records the string that triggered
 * it, so a surprising tick in the grid can be explained by clicking through
 * rather than doubted.
 *
 * These rules are deliberately conservative — a false negative is a checkbox
 * Carl ticks once; a false positive is a number he stops trusting.
 */

export type Capability = "EMAIL" | "SHAREPOINT" | "EXTERNAL_DATA";
export type SignalSource = "ENV_KEY" | "DEPENDENCY" | "MANUAL";

export interface Signal {
  capability: Capability;
  source: SignalSource;
  evidence: string;
}

export type StoreKind = "BLOB" | "POSTGRES" | "REDIS" | "EDGE_CONFIG" | "OTHER";

export interface InferredStore {
  kind: StoreKind;
  provider: string | null;
  name: string;
}

export interface InferredConnection {
  label: string;
  detail?: string;
}

interface Rule {
  /** Matched against the whole key, case-insensitive. */
  pattern: RegExp;
  capability: Capability;
}

// ------------------------------------------------------------- email

const EMAIL_ENV_RULES: Rule[] = [
  { pattern: /^RESEND_/, capability: "EMAIL" },
  { pattern: /^SENDGRID_/, capability: "EMAIL" },
  { pattern: /^POSTMARK_/, capability: "EMAIL" },
  { pattern: /^MAILGUN_/, capability: "EMAIL" },
  { pattern: /^SMTP_/, capability: "EMAIL" },
  { pattern: /^(MAIL|EMAIL)_(FROM|HOST|PROVIDER|USER|PASS)/, capability: "EMAIL" },
  { pattern: /^NODEMAILER_/, capability: "EMAIL" },
  // Carl's Graph mailer pattern (COLAB Hub, Cubana) — a dedicated sender mailbox.
  { pattern: /^(GRAPH|MS_GRAPH|MSGRAPH)_(MAIL|SENDER|FROM)/, capability: "EMAIL" },
];

const EMAIL_DEPS = [
  "resend",
  "nodemailer",
  "@sendgrid/mail",
  "postmark",
  "mailgun.js",
  "@aws-sdk/client-ses",
  "react-email",
  "@react-email/components",
];

// --------------------------------------------------------- sharepoint

const SHAREPOINT_ENV_RULES: Rule[] = [
  { pattern: /SHAREPOINT/, capability: "SHAREPOINT" },
  { pattern: /^SP_(SITE|DRIVE|LIST|FOLDER)/, capability: "SHAREPOINT" },
  { pattern: /^(GRAPH|MS_GRAPH|MSGRAPH)_(SITE|DRIVE|LIST)/, capability: "SHAREPOINT" },
  { pattern: /^ONEDRIVE_/, capability: "SHAREPOINT" },
];

const SHAREPOINT_DEPS = [
  "@microsoft/microsoft-graph-client",
  "@pnp/sp",
  "@pnp/graph",
  "sp-rest-proxy",
];

// ------------------------------------------------- external data sources
// Deliberately excludes the app's OWN database (Neon/Postgres/Blob) — that's
// the "number of DBs" column. This column means *someone else's* system.

const EXTERNAL_ENV_RULES: Rule[] = [
  { pattern: /^(MSSQL|SQLSERVER|SQL_SERVER)_/, capability: "EXTERNAL_DATA" },
  { pattern: /^SAP_/, capability: "EXTERNAL_DATA" },
  { pattern: /^ODBC_/, capability: "EXTERNAL_DATA" },
  { pattern: /^(MYSQL|MARIADB)_/, capability: "EXTERNAL_DATA" },
  { pattern: /^ORACLE_/, capability: "EXTERNAL_DATA" },
  { pattern: /^SNOWFLAKE_/, capability: "EXTERNAL_DATA" },
  { pattern: /^BIGQUERY_/, capability: "EXTERNAL_DATA" },
  // Client systems Carl actually integrates with.
  { pattern: /^PERIGEE_/, capability: "EXTERNAL_DATA" },
  { pattern: /^REPSLY_/, capability: "EXTERNAL_DATA" },
  { pattern: /^ARIA_(API|DB|SQL)/, capability: "EXTERNAL_DATA" },
  { pattern: /^SAMS_/, capability: "EXTERNAL_DATA" },
];

const EXTERNAL_DEPS = [
  "mssql",
  "tedious",
  "mysql2",
  "oracledb",
  "snowflake-sdk",
  "@google-cloud/bigquery",
  "odbc",
];

/** Human label for an external connection, keyed off the env prefix. */
const EXTERNAL_LABELS: Array<[RegExp, string]> = [
  [/^(MSSQL|SQLSERVER|SQL_SERVER)_/, "MS SQL Server"],
  [/^SAP_/, "SAP"],
  [/^(MYSQL|MARIADB)_/, "MySQL / MariaDB"],
  [/^ORACLE_/, "Oracle"],
  [/^SNOWFLAKE_/, "Snowflake"],
  [/^BIGQUERY_/, "BigQuery"],
  [/^PERIGEE_/, "Perigee API"],
  [/^REPSLY_/, "Repsly API"],
  [/^ARIA_/, "ARIA"],
  [/^SAMS_/, "SAMS"],
  [/^ODBC_/, "ODBC"],
];

const ALL_ENV_RULES = [...EMAIL_ENV_RULES, ...SHAREPOINT_ENV_RULES, ...EXTERNAL_ENV_RULES];

const DEP_RULES: Array<[string[], Capability]> = [
  [EMAIL_DEPS, "EMAIL"],
  [SHAREPOINT_DEPS, "SHAREPOINT"],
  [EXTERNAL_DEPS, "EXTERNAL_DATA"],
];

// ------------------------------------------------------------- stores

/**
 * The app's own storage, inferred from env keys. Vercel's storage API is the
 * primary source; this is the fallback that catches stores connected outside
 * the marketplace (a hand-pasted Neon URL, a Supabase project).
 */
const STORE_ENV_RULES: Array<[RegExp, StoreKind, string | null]> = [
  [/^BLOB_READ_WRITE_TOKEN$/, "BLOB", "Vercel Blob"],
  [/^POSTGRES_/, "POSTGRES", "Neon"],
  [/^DATABASE_URL$/, "POSTGRES", null],
  [/^NEON_/, "POSTGRES", "Neon"],
  [/^SUPABASE_/, "POSTGRES", "Supabase"],
  [/^(KV|REDIS)_/, "REDIS", "Upstash"],
  [/^UPSTASH_/, "REDIS", "Upstash"],
  [/^EDGE_CONFIG$/, "EDGE_CONFIG", "Vercel Edge Config"],
];

// ------------------------------------------------------------- public API

/** Infer capability signals from a project's env var keys. */
export function signalsFromEnvKeys(keys: string[]): Signal[] {
  const out: Signal[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    for (const rule of ALL_ENV_RULES) {
      if (!rule.pattern.test(key.toUpperCase())) continue;
      const dedupe = `${rule.capability}:${key}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      out.push({ capability: rule.capability, source: "ENV_KEY", evidence: key });
    }
  }
  return out;
}

/** Infer capability signals from package.json dependency names. */
export function signalsFromDependencies(deps: string[]): Signal[] {
  const out: Signal[] = [];
  const lower = new Set(deps.map((d) => d.toLowerCase()));

  for (const [names, capability] of DEP_RULES) {
    for (const name of names) {
      if (lower.has(name.toLowerCase())) {
        out.push({ capability, source: "DEPENDENCY", evidence: name });
      }
    }
  }
  return out;
}

/** Infer the app's own storage from env var keys. */
export function storesFromEnvKeys(keys: string[]): InferredStore[] {
  const byName = new Map<string, InferredStore>();

  for (const key of keys) {
    for (const [pattern, kind, provider] of STORE_ENV_RULES) {
      if (!pattern.test(key.toUpperCase())) continue;
      // One store per kind+provider — POSTGRES_URL and POSTGRES_PRISMA_URL are
      // the same database, not two.
      const name = provider ?? defaultStoreName(kind);
      if (!byName.has(name)) byName.set(name, { kind, provider, name });
    }
  }
  return [...byName.values()];
}

/** Infer external systems (with human labels) from env var keys. */
export function connectionsFromEnvKeys(keys: string[]): InferredConnection[] {
  const byLabel = new Map<string, InferredConnection>();

  for (const key of keys) {
    for (const [pattern, label] of EXTERNAL_LABELS) {
      if (!pattern.test(key.toUpperCase())) continue;
      if (!byLabel.has(label)) byLabel.set(label, { label, detail: key });
    }
  }
  return [...byLabel.values()];
}

function defaultStoreName(kind: StoreKind): string {
  switch (kind) {
    case "POSTGRES":
      return "Postgres";
    case "BLOB":
      return "Blob";
    case "REDIS":
      return "Redis";
    case "EDGE_CONFIG":
      return "Edge Config";
    default:
      return "Store";
  }
}

/** Roll signals up into the three boolean flags the grid renders. */
export function rollUp(signals: Signal[]) {
  return {
    sendsEmailAuto: signals.some((s) => s.capability === "EMAIL"),
    usesSharePointAuto: signals.some((s) => s.capability === "SHAREPOINT"),
    externalDataAuto: signals.some((s) => s.capability === "EXTERNAL_DATA"),
  };
}

/** Effective flag value — a manual override always beats detection. */
export function effective(auto: boolean, override: boolean | null | undefined): boolean {
  return override ?? auto;
}
