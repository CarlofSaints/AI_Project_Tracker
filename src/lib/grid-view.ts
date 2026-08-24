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
  /**
   * Starting width in pixels for the on-screen grid. Only a starting point —
   * every column can be dragged wider or narrower and the choice is remembered
   * per browser. The Excel export ignores this and sizes its own columns.
   */
  defaultWidth: number;
  /** Sort/export value. Null sorts last and exports blank. */
  value: (p: ViewProject) => string | number | boolean | Date | null;
}

/**
 * Resizing bounds. The floor keeps a column from being dragged away to nothing
 * and stranded — there would be no handle left to drag back.
 */
export const MIN_COLUMN_WIDTH = 56;
export const MAX_COLUMN_WIDTH = 640;

export function clampColumnWidth(width: number): number {
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width)));
}

/** The expand chevron sits in its own unlabelled, unresizable column. */
export const CHEVRON_COLUMN_WIDTH = 40;

export function defaultColumnWidths(): Record<string, number> {
  return Object.fromEntries(COLUMNS.map((column) => [column.key, column.defaultWidth]));
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
  { key: "name", label: "Project", type: "text", defaultWidth: 240, value: (p) => p.name },
  {
    key: "owner",
    label: "Owner / scope",
    type: "text",
    defaultWidth: 140,
    value: (p) => p.gitOwner,
  },
  { key: "repo", label: "Repo", type: "text", defaultWidth: 160, value: (p) => p.gitRepo },
  {
    key: "vercel",
    label: "Vercel",
    type: "text",
    defaultWidth: 140,
    value: (p) => p.vercelProjectName,
  },
  {
    key: "deployed",
    label: "Latest Deployment",
    type: "date",
    defaultWidth: 116,
    value: (p) => p.lastDeployedAt,
  },
  {
    key: "env",
    label: "Env",
    type: "number",
    align: "right",
    defaultWidth: 60,
    value: (p) => p.envVarCount,
  },
  {
    key: "domains",
    label: "Domains",
    type: "number",
    align: "right",
    defaultWidth: 80,
    value: (p) => p.domainCount,
  },
  {
    key: "dbs",
    label: "DBs",
    type: "number",
    align: "right",
    defaultWidth: 60,
    value: (p) => p.databaseCount,
  },
  // Client and customer hold whole company names inside a dropdown, so they
  // need real room. Anything narrower cut them off before the name was legible.
  {
    key: "client",
    label: "Client",
    type: "text",
    defaultWidth: 200,
    value: (p) => p.client?.name ?? null,
  },
  {
    key: "customer",
    label: "Customer",
    type: "text",
    defaultWidth: 200,
    value: (p) => p.endCustomer?.name ?? null,
  },
  {
    key: "email",
    label: "Email",
    type: "boolean",
    align: "center",
    defaultWidth: 68,
    value: (p) => effective(p.sendsEmailAuto, p.sendsEmailOverride),
  },
  {
    key: "sharepoint",
    label: "SP",
    type: "boolean",
    align: "center",
    defaultWidth: 58,
    value: (p) => effective(p.usesSharePointAuto, p.usesSharePointOverride),
  },
  {
    key: "external",
    label: "Ext. data",
    type: "boolean",
    align: "center",
    defaultWidth: 86,
    value: (p) => effective(p.externalDataAuto, p.externalDataOverride),
  },
  { key: "stage", label: "Progress", type: "stage", defaultWidth: 134, value: (p) => p.stage },
];

const BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

export function columnByKey(key: string | null): ColumnDef | null {
  return key ? (BY_KEY.get(key) ?? null) : null;
}

/**
 * The house rule is that every project has a client, and ideally an end
 * customer too. Anything short of that is unbilled work, so these filters
 * exist to make the gaps findable rather than something you have to notice.
 */
export type AssignmentFilter = "all" | "no-client" | "no-customer" | "incomplete";

export const ASSIGNMENT_FILTERS: { value: AssignmentFilter; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Every project" },
  {
    value: "no-client",
    label: "No client",
    hint: "Projects with nobody to invoice — the ones that cost you money",
  },
  {
    value: "no-customer",
    label: "No customer",
    hint: "Projects where the end customer the work was for isn't recorded",
  },
  {
    value: "incomplete",
    label: "Missing either",
    hint: "Projects missing a client, an end customer, or both",
  },
];

export function matchesAssignment(p: ViewProject, filter: AssignmentFilter): boolean {
  switch (filter) {
    case "no-client":
      return !p.client;
    case "no-customer":
      return !p.endCustomer;
    case "incomplete":
      return !p.client || !p.endCustomer;
    default:
      return true;
  }
}

export function filterByAssignment<T extends ViewProject>(
  projects: T[],
  filter: AssignmentFilter,
): T[] {
  if (filter === "all") return projects;
  return projects.filter((p) => matchesAssignment(p, filter));
}

/** Anything unrecognised falls back to showing everything, never to a subset. */
export function parseAssignmentFilter(value: string | null): AssignmentFilter {
  return ASSIGNMENT_FILTERS.some((f) => f.value === value) ? (value as AssignmentFilter) : "all";
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
