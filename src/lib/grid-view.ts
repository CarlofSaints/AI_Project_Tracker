/**
 * Column definitions, filtering and sorting for the project grid.
 *
 * Deliberately framework-agnostic and shared by both the client grid and the
 * Excel export route. The export is meant to contain exactly the rows you are
 * looking at, and the only reliable way to guarantee that is for both to run
 * the same code rather than two implementations that agree until they don't.
 */

export type SortDirection = "asc" | "desc";
export type ColumnType = "text" | "number" | "date" | "boolean" | "stage";

/** The minimum shape both callers satisfy. */
export interface ViewProject {
  name: string;
  gitOwner: string | null;
  gitRepo: string | null;
  vercelProjectName: string | null;
  vercelScopeName: string | null;
  productionUrl: string | null;
  lastDeployedAt: Date | null;
  envVarCount: number;
  domainCount: number;
  databaseCount: number;
  stage: string;
  client: { name: string } | null;
  endCustomer: { name: string } | null;
  sendsEmailAuto: boolean;
  sendsEmailOverride: boolean | null;
  usesSharePointAuto: boolean;
  usesSharePointOverride: boolean | null;
  externalDataAuto: boolean;
  externalDataOverride: boolean | null;
}

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  align?: "left" | "right" | "center";
  /** Sort/export value. Null sorts last and exports blank. */
  value: (p: ViewProject) => string | number | boolean | Date | null;
}

/** A manual override always wins over detection — same rule as the grid cells. */
const effective = (auto: boolean, override: boolean | null) => override ?? auto;

/** Progress is ordered by how far along the work is, not alphabetically. */
const STAGE_ORDER: Record<string, number> = {
  DEVELOPMENT: 0,
  LIVE_ITERATING: 1,
  HANDED_OVER: 2,
  ARCHIVED: 3,
};

export const STAGE_LABELS: Record<string, string> = {
  DEVELOPMENT: "In development",
  LIVE_ITERATING: "Live, iterating",
  HANDED_OVER: "Handed over",
  ARCHIVED: "Archived",
};

export const COLUMNS: ColumnDef[] = [
  { key: "name", label: "Project", type: "text", value: (p) => p.name },
  { key: "owner", label: "Owner / scope", type: "text", value: (p) => p.gitOwner },
  { key: "repo", label: "Repo", type: "text", value: (p) => p.gitRepo },
  { key: "vercel", label: "Vercel", type: "text", value: (p) => p.vercelProjectName },
  { key: "deployed", label: "Latest Deployment", type: "date", value: (p) => p.lastDeployedAt },
  { key: "env", label: "Env", type: "number", align: "right", value: (p) => p.envVarCount },
  { key: "domains", label: "Domains", type: "number", align: "right", value: (p) => p.domainCount },
  { key: "dbs", label: "DBs", type: "number", align: "right", value: (p) => p.databaseCount },
  { key: "client", label: "Client", type: "text", value: (p) => p.client?.name ?? null },
  { key: "customer", label: "Customer", type: "text", value: (p) => p.endCustomer?.name ?? null },
  {
    key: "email",
    label: "Email",
    type: "boolean",
    align: "center",
    value: (p) => effective(p.sendsEmailAuto, p.sendsEmailOverride),
  },
  {
    key: "sharepoint",
    label: "SP",
    type: "boolean",
    align: "center",
    value: (p) => effective(p.usesSharePointAuto, p.usesSharePointOverride),
  },
  {
    key: "external",
    label: "Ext. data",
    type: "boolean",
    align: "center",
    value: (p) => effective(p.externalDataAuto, p.externalDataOverride),
  },
  { key: "stage", label: "Progress", type: "stage", value: (p) => p.stage },
];

const BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

export function columnByKey(key: string | null): ColumnDef | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/**
 * First click direction. Text reads naturally A–Z, but for dates, counts and
 * yes/no the interesting end is the top — newest deploys, most env vars, the
 * projects that do send email.
 */
export function defaultDirection(type: ColumnType): SortDirection {
  return type === "text" ? "asc" : "desc";
}

export function filterProjects<T extends ViewProject>(projects: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;

  return projects.filter((p) =>
    [p.name, p.gitRepo, p.gitOwner, p.vercelProjectName, p.client?.name, p.endCustomer?.name]
      .filter(Boolean)
      .some((field) => field!.toLowerCase().includes(q)),
  );
}

/**
 * Sort by a column key. Passing a null key returns the input untouched, which
 * preserves the server's default ordering (most recently pushed first) as a
 * distinct third state from asc and desc.
 *
 * Nulls always sort last regardless of direction — a project with no deploy
 * date is missing information, not the oldest thing in the list.
 */
export function sortProjects<T extends ViewProject>(
  projects: T[],
  key: string | null,
  direction: SortDirection,
): T[] {
  const column = columnByKey(key);
  if (!column) return projects;

  const sign = direction === "asc" ? 1 : -1;

  return [...projects].sort((a, b) => {
    const av = column.value(a);
    const bv = column.value(b);

    const aEmpty = av === null || av === "";
    const bEmpty = bv === null || bv === "";
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    return sign * compare(av!, bv!, column.type);
  });
}

function compare(
  a: string | number | boolean | Date,
  b: string | number | boolean | Date,
  type: ColumnType,
): number {
  switch (type) {
    case "date":
      return new Date(a as Date).getTime() - new Date(b as Date).getTime();
    case "number":
      return (a as number) - (b as number);
    case "boolean":
      return Number(a as boolean) - Number(b as boolean);
    case "stage":
      return (STAGE_ORDER[a as string] ?? 99) - (STAGE_ORDER[b as string] ?? 99);
    default:
      return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
  }
}
