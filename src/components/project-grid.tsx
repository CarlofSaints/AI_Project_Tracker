"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addProjectNote,
  cycleCapabilityOverride,
  deleteProjectNote,
  updateProjectAssignment,
} from "@/app/actions";
import {
  ASSIGNMENT_FILTERS,
  CHEVRON_COLUMN_WIDTH,
  COLUMNS,
  clampColumnWidth,
  columnByKey,
  defaultColumnWidths,
  defaultDirection,
  filterByAssignment,
  filterProjects,
  matchesAssignment,
  sortProjects,
  type AssignmentFilter,
  type SortDirection,
} from "@/lib/grid-view";

/** Column widths are a per-browser preference, so they live in localStorage. */
const WIDTHS_STORAGE_KEY = "ai-project-tracker:grid-column-widths:v1";

type Capability = "EMAIL" | "SHAREPOINT" | "EXTERNAL_DATA";
type Stage = "DEVELOPMENT" | "LIVE_ITERATING" | "HANDED_OVER" | "ARCHIVED";
type NoteAuthor = "CARL" | "ASSISTANT";

export interface GridNote {
  id: string;
  body: string;
  author: NoteAuthor;
  createdAt: Date;
}

export interface GridProject {
  id: string;
  name: string;
  vercelProjectName: string | null;
  vercelScopeName: string | null;
  productionUrl: string | null;
  gitOwner: string | null;
  gitOwnerType: "USER" | "ORGANIZATION" | null;
  gitRepo: string | null;
  gitUrl: string | null;
  gitPushedAt: Date | null;
  lastDeployedAt: Date | null;
  envVarCount: number;
  domainCount: number;
  databaseCount: number;
  stage: Stage;
  hidden: boolean;
  clientId: string | null;
  endCustomerId: string | null;
  sendsEmailAuto: boolean;
  sendsEmailOverride: boolean | null;
  usesSharePointAuto: boolean;
  usesSharePointOverride: boolean | null;
  externalDataAuto: boolean;
  externalDataOverride: boolean | null;
  client: { id: string; name: string } | null;
  endCustomer: { id: string; name: string } | null;
  databases: { id: string; kind: string; provider: string | null; name: string }[];
  connections: { id: string; label: string; detail: string | null }[];
  domains: { id: string; domain: string; verified: boolean; isVercelDomain: boolean }[];
  signals: { id: string; capability: Capability; source: string; evidence: string }[];
  noteEntries: GridNote[];
}

interface Org {
  id: string;
  name: string;
}

const STAGES: { value: Stage; label: string; className: string }[] = [
  {
    value: "DEVELOPMENT",
    label: "In development",
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  },
  {
    value: "LIVE_ITERATING",
    label: "Live, iterating",
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  {
    value: "HANDED_OVER",
    label: "Handed over",
    className: "bg-sky-100 text-sky-900 dark:bg-sky-500/15 dark:text-sky-300",
  },
  {
    value: "ARCHIVED",
    label: "Archived",
    className: "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300",
  },
];

export function ProjectGrid({
  projects,
  organizations,
}: {
  projects: GridProject[];
  organizations: Org[];
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  // A null sortKey means "server order" (most recently pushed first), which is
  // a genuinely useful third state rather than just the absence of a sort.
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>("desc");
  const [assignment, setAssignment] = useState<AssignmentFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [widths, setWidths] = useState<Record<string, number>>(defaultColumnWidths);
  // Server and first client render must agree, so the stored widths are only
  // applied after mount. Until then everyone sees the defaults.
  const [widthsHydrated, setWidthsHydrated] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(WIDTHS_STORAGE_KEY);
      if (raw) {
        const stored = JSON.parse(raw) as Record<string, unknown>;
        setWidths(() => {
          // Rebuilt from COLUMNS rather than from what was stored, so a column
          // that has since been removed or renamed can't come back as a ghost.
          const next = defaultColumnWidths();
          for (const column of COLUMNS) {
            const value = stored[column.key];
            if (typeof value === "number" && Number.isFinite(value)) {
              next[column.key] = clampColumnWidth(value);
            }
          }
          return next;
        });
      }
    } catch {
      // A private window, a blocked store or corrupt JSON just means defaults.
    }
    setWidthsHydrated(true);
  }, []);

  useEffect(() => {
    if (!widthsHydrated) return;
    try {
      window.localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Not being able to remember the widths is not worth breaking the grid.
    }
  }, [widths, widthsHydrated]);

  const totalWidth =
    CHEVRON_COLUMN_WIDTH +
    COLUMNS.reduce((sum, column) => sum + (widths[column.key] ?? column.defaultWidth), 0);

  const widthsAreCustom = COLUMNS.some(
    (column) => (widths[column.key] ?? column.defaultWidth) !== column.defaultWidth,
  );

  /**
   * Drag-to-resize. The pointer is captured on the handle itself, so the drag
   * keeps working when the cursor runs ahead of the column or leaves the table.
   */
  function startResize(key: string, event: React.PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();

    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = widths[key] ?? columnByKey(key)?.defaultWidth ?? CHEVRON_COLUMN_WIDTH;

    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Capture is an improvement, not a requirement. If the browser refuses
      // the pointer id, the drag must still run rather than die on the spot.
    }

    const onMove = (move: PointerEvent) => {
      const next = clampColumnWidth(startWidth + (move.clientX - startX));
      setWidths((current) => (current[key] === next ? current : { ...current, [key]: next }));
    };

    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };

    // Listened for on the window, not the handle. Pointer capture already
    // redirects the events here, and if the browser ever refuses the capture
    // the drag still tracks a cursor that has run off a 10px strip.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  /** Double-clicking a handle puts that one column back to its default. */
  function resetColumn(key: string) {
    const column = columnByKey(key);
    if (!column) return;
    setWidths((current) => ({ ...current, [key]: column.defaultWidth }));
  }

  const shown = useMemo(
    () => (showHidden ? projects : projects.filter((p) => !p.hidden)),
    [projects, showHidden],
  );

  const filtered = useMemo(
    () =>
      sortProjects(
        filterByAssignment(filterProjects(shown, query), assignment),
        sortKey,
        sortDir,
      ),
    [shown, query, assignment, sortKey, sortDir],
  );

  const hiddenCount = useMemo(() => projects.filter((p) => p.hidden).length, [projects]);

  // Counted against what is currently visible, so hiding a dead project also
  // takes it out of the "no client" count rather than nagging about it forever.
  const assignmentCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const filter of ASSIGNMENT_FILTERS) {
      counts[filter.value] =
        filter.value === "all"
          ? shown.length
          : shown.filter((p) => matchesAssignment(p, filter.value)).length;
    }
    return counts;
  }, [shown]);

  /** asc → desc → unsorted, so you can always get back to the default order. */
  function toggleSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir(defaultDirection(columnByKey(key)?.type ?? "text"));
      return;
    }
    const first = defaultDirection(columnByKey(key)?.type ?? "text");
    if (sortDir === first) {
      setSortDir(first === "asc" ? "desc" : "asc");
    } else {
      setSortKey(null);
    }
  }

  // The spreadsheet is meant to be the rows on screen, so every filter that
  // narrows the grid has to travel with the link.
  const exportHref = `/api/export?${new URLSearchParams({
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(sortKey ? { sort: sortKey, dir: sortDir } : {}),
    ...(assignment !== "all" ? { assignment } : {}),
    ...(showHidden ? { hidden: "1" } : {}),
  })}`;

  function save(id: string, patch: Parameters<typeof updateProjectAssignment>[1]) {
    startTransition(async () => {
      await updateProjectAssignment(id, patch);
      router.refresh();
    });
  }

  function cycle(id: string, field: Parameters<typeof cycleCapabilityOverride>[1]) {
    startTransition(async () => {
      await cycleCapabilityOverride(id, field);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter projects, repos, clients…"
          className="w-72 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-800 dark:bg-neutral-900"
        />
        <div className="flex items-center gap-4">
          <span className="text-xs text-neutral-500 dark:text-neutral-400">
            {filtered.length} of {shown.length}
          </span>
          {widthsAreCustom ? (
            <button
              type="button"
              onClick={() => setWidths(defaultColumnWidths())}
              title="Put every column back to its starting width"
              className="text-xs text-neutral-500 underline-offset-2 transition hover:text-[var(--brand-text)] hover:underline dark:text-neutral-400"
            >
              Reset column widths
            </button>
          ) : null}
          {/* A plain link, not fetch+blob — the browser handles the download and
              reuses the credentials it already holds for this origin. */}
          <a
            href={exportHref}
            className="rounded-lg border border-neutral-200 px-3 py-2 text-sm font-medium transition hover:border-[var(--brand)] hover:text-[var(--brand-text)] dark:border-neutral-700"
          >
            Export to Excel
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {ASSIGNMENT_FILTERS.map((filter) => {
          const active = assignment === filter.value;
          const count = assignmentCounts[filter.value] ?? 0;
          return (
            <button
              key={filter.value}
              type="button"
              onClick={() => setAssignment(filter.value)}
              title={filter.hint}
              aria-pressed={active}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                active
                  ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-text)]"
                  : "border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
              }`}
            >
              {filter.label}
              <span className="ml-1.5 tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}

        {hiddenCount > 0 ? (
          <button
            type="button"
            onClick={() => setShowHidden((current) => !current)}
            aria-pressed={showHidden}
            title="Projects you have removed from the list. They stay in the database so a sync can't quietly bring them back."
            className={`ml-auto rounded-full border px-3 py-1 text-xs font-medium transition ${
              showHidden
                ? "border-neutral-400 bg-neutral-100 text-neutral-700 dark:border-neutral-500 dark:bg-neutral-800 dark:text-neutral-200"
                : "border-neutral-200 text-neutral-500 hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-400"
            }`}
          >
            {showHidden ? "Hide removed" : "Show removed"}
            <span className="ml-1.5 tabular-nums opacity-60">{hiddenCount}</span>
          </button>
        ) : null}
      </div>

      {/* The scroll container needs a bounded height for a sticky header to have
          anything to stick to — position:sticky resolves against the nearest
          scrolling ancestor, and an unbounded div never scrolls. */}
      <div className="max-h-[calc(100vh-19rem)] overflow-auto rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        {/* table-fixed is what makes the widths below authoritative — under the
            default auto layout the browser re-measures from the content and a
            dragged width is ignored. */}
        <table className="grid-fixed table-fixed text-sm" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: CHEVRON_COLUMN_WIDTH }} />
            {COLUMNS.map((column) => (
              <col
                key={column.key}
                style={{ width: widths[column.key] ?? column.defaultWidth }}
              />
            ))}
          </colgroup>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              {/* Tailwind's preflight sets border-collapse:collapse, under which a
                  sticky cell's own border is dropped as the table collapses its
                  borders. An inset shadow draws the same 1px rule and survives. */}
              <th className="sticky top-0 z-10 bg-white px-3 py-3 shadow-[inset_0_-1px_0_#e5e5e5] dark:bg-neutral-900 dark:shadow-[inset_0_-1px_0_#262626]" />
              {COLUMNS.map((column) => {
                const active = sortKey === column.key;
                const alignment =
                  column.align === "right"
                    ? "text-right"
                    : column.align === "center"
                      ? "text-center"
                      : "text-left";
                return (
                  <th
                    key={column.key}
                    aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                    className={`sticky top-0 z-10 bg-white px-3 py-3 font-medium shadow-[inset_0_-1px_0_#e5e5e5] dark:bg-neutral-900 dark:shadow-[inset_0_-1px_0_#262626] ${alignment}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(column.key)}
                      title={`Sort by ${column.label}`}
                      className={`group inline-flex max-w-full items-center gap-1 truncate uppercase transition hover:text-[var(--brand-text)] ${
                        active ? "text-[var(--brand-text)]" : ""
                      }`}
                    >
                      {column.label}
                      <span
                        aria-hidden
                        className={`text-[9px] ${
                          active ? "" : "opacity-0 transition group-hover:opacity-40"
                        }`}
                      >
                        {active && sortDir === "asc" ? "▲" : "▼"}
                      </span>
                    </button>

                    {/* Sits inside the header cell, on its right edge. Widening
                        the hit area with padding would put it over the sort
                        button, so it stays narrow and lights up on hover. */}
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label}`}
                      title="Drag to resize, double-click to reset"
                      onPointerDown={(event) => startResize(column.key, event)}
                      onDoubleClick={() => resetColumn(column.key)}
                      className="absolute inset-y-0 right-0 z-10 w-2.5 cursor-col-resize touch-none select-none bg-transparent transition hover:bg-[var(--brand)]"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p) => {
              const isOpen = expanded === p.id;
              return (
                <RowGroup
                  key={p.id}
                  project={p}
                  organizations={organizations}
                  isOpen={isOpen}
                  onToggle={() => setExpanded(isOpen ? null : p.id)}
                  onSave={save}
                  onCycle={cycle}
                />
              );
            })}
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={15}
                  className="px-4 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400"
                >
                  {projects.length === 0
                    ? "No projects yet — hit “Sync now” to pull them from Vercel and GitHub."
                    : assignment === "no-client"
                      ? "Every project on screen has a client. Nothing to chase."
                      : assignment !== "all"
                        ? "Nothing missing under that filter."
                        : "Nothing matches that filter."}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowGroup({
  project: p,
  organizations,
  isOpen,
  onToggle,
  onSave,
  onCycle,
}: {
  project: GridProject;
  organizations: Org[];
  isOpen: boolean;
  onToggle: () => void;
  onSave: (id: string, patch: Parameters<typeof updateProjectAssignment>[1]) => void;
  onCycle: (id: string, field: Parameters<typeof cycleCapabilityOverride>[1]) => void;
}) {
  const stage = STAGES.find((s) => s.value === p.stage) ?? STAGES[0];

  return (
    <>
      <tr
        className={`border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40 ${
          // Only ever on screen when "Show removed" is on, so it needs to be
          // obvious that this row is not part of the live list.
          p.hidden ? "opacity-50" : ""
        }`}
      >
        <td className="px-3 py-2 align-middle">
          <button
            onClick={onToggle}
            aria-label={isOpen ? "Collapse details" : "Expand details"}
            aria-expanded={isOpen}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 transition hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-200"
          >
            <span className={`transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
          </button>
        </td>

        <td className="px-3 py-2">
          {/* Truncation lives on the content, not the cell: a narrowed column
              should end in an ellipsis, not a letter sliced down the middle. */}
          <div className="truncate font-medium" title={p.name}>
            {p.hidden ? (
              <span className="mr-1.5 rounded bg-neutral-200 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                Removed
              </span>
            ) : null}
            {p.name}
          </div>
          {p.productionUrl ? (
            <a
              href={`https://${p.productionUrl}`}
              target="_blank"
              rel="noreferrer"
              title={p.productionUrl}
              className="block truncate text-xs text-neutral-500 hover:underline dark:text-neutral-400"
            >
              {p.productionUrl}
            </a>
          ) : null}
        </td>

        <td className="px-3 py-2">
          {p.gitOwner ? (
            <span
              className={`inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-xs font-medium ${
                p.gitOwnerType === "ORGANIZATION"
                  ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
                  : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
              title={`${p.gitOwner} — ${
                p.gitOwnerType === "ORGANIZATION" ? "GitHub organisation" : "Personal account"
              }`}
            >
              {p.gitOwner}
            </span>
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          )}
          {p.vercelScopeName ? (
            <div
              title={p.vercelScopeName}
              className="mt-0.5 truncate text-xs text-neutral-400 dark:text-neutral-500"
            >
              {p.vercelScopeName}
            </div>
          ) : null}
        </td>

        <td className="px-3 py-2">
          {p.gitUrl ? (
            <a
              href={p.gitUrl}
              target="_blank"
              rel="noreferrer"
              title={p.gitRepo ?? undefined}
              className="block truncate font-mono text-xs hover:underline"
            >
              {p.gitRepo}
            </a>
          ) : (
            <span className="text-xs text-neutral-400">not on GitHub</span>
          )}
        </td>

        <td
          className="truncate px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400"
          title={p.vercelProjectName ?? undefined}
        >
          {p.vercelProjectName ?? <span className="text-neutral-400">not deployed</span>}
        </td>

        <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
          {p.lastDeployedAt ? (
            <span suppressHydrationWarning title={formatDateTime(p.lastDeployedAt)}>
              {formatDate(p.lastDeployedAt)}
            </span>
          ) : (
            <span className="text-neutral-400">—</span>
          )}
        </td>

        <td className="px-3 py-2 text-right tabular-nums">{p.envVarCount || "—"}</td>

        <td className="px-3 py-2 text-right tabular-nums">
          <CountButton count={p.domainCount} onClick={onToggle} />
        </td>

        <td className="px-3 py-2 text-right tabular-nums">
          <CountButton count={p.databaseCount} onClick={onToggle} />
        </td>

        <td className="px-3 py-2">
          <OrgSelect
            value={p.clientId}
            organizations={organizations}
            placeholder="— client —"
            onChange={(clientId) => onSave(p.id, { clientId })}
          />
        </td>

        <td className="px-3 py-2">
          <OrgSelect
            value={p.endCustomerId}
            organizations={organizations}
            placeholder="— customer —"
            onChange={(endCustomerId) => onSave(p.id, { endCustomerId })}
          />
        </td>

        <td className="px-3 py-2 text-center">
          <CapabilityCell
            auto={p.sendsEmailAuto}
            override={p.sendsEmailOverride}
            signals={p.signals.filter((s) => s.capability === "EMAIL")}
            onClick={() => onCycle(p.id, "sendsEmailOverride")}
          />
        </td>

        <td className="px-3 py-2 text-center">
          <CapabilityCell
            auto={p.usesSharePointAuto}
            override={p.usesSharePointOverride}
            signals={p.signals.filter((s) => s.capability === "SHAREPOINT")}
            onClick={() => onCycle(p.id, "usesSharePointOverride")}
          />
        </td>

        <td className="px-3 py-2 text-center">
          <CapabilityCell
            auto={p.externalDataAuto}
            override={p.externalDataOverride}
            signals={p.signals.filter((s) => s.capability === "EXTERNAL_DATA")}
            onClick={() => onCycle(p.id, "externalDataOverride")}
          />
        </td>

        <td className="px-3 py-2">
          <select
            value={p.stage}
            onChange={(e) => onSave(p.id, { stage: e.target.value as Stage })}
            className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium outline-none ${stage.className}`}
          >
            {STAGES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </td>
      </tr>

      {isOpen ? (
        <tr className="border-b border-neutral-100 bg-neutral-50/60 dark:border-neutral-800/60 dark:bg-neutral-800/30">
          <td colSpan={15} className="px-12 py-4">
            <div className="grid gap-6 md:grid-cols-3">
              <DetailList
                title="Databases"
                empty="No storage detected"
                items={p.databases.map((d) => ({
                  id: d.id,
                  primary: d.provider ?? d.name,
                  secondary: d.kind.replace("_", " ").toLowerCase(),
                }))}
              />
              <DetailList
                title="Domains"
                empty="No domains"
                items={p.domains.map((d) => ({
                  id: d.id,
                  primary: d.domain,
                  secondary: d.isVercelDomain ? "vercel" : d.verified ? "verified" : "unverified",
                }))}
              />
              <DetailList
                title="External data"
                empty="No external systems detected"
                items={p.connections.map((c) => ({
                  id: c.id,
                  primary: c.label,
                  secondary: c.detail ?? undefined,
                }))}
              />
            </div>

            {p.signals.length > 0 ? (
              <div className="mt-5 border-t border-neutral-200 pt-3 dark:border-neutral-700">
                <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                  Why these flags are ticked
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {p.signals.map((s) => (
                    <span
                      key={s.id}
                      className="rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-[var(--brand-2-text)] ring-1 ring-neutral-200 dark:bg-neutral-900 dark:ring-neutral-700"
                      title={`${s.capability} · from ${s.source.replace("_", " ").toLowerCase()}`}
                    >
                      {s.evidence}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}

            <NotesPanel projectId={p.id} notes={p.noteEntries} />

            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-3 dark:border-neutral-700">
              <button
                type="button"
                onClick={() => onSave(p.id, { hidden: !p.hidden })}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-medium transition hover:border-red-400 hover:text-red-600 dark:border-neutral-700 dark:hover:border-red-500 dark:hover:text-red-400"
              >
                {p.hidden ? "Put back in the list" : "Remove from the list"}
              </button>
              <span className="text-xs text-neutral-400 dark:text-neutral-500">
                {p.hidden
                  ? "Hidden from the dashboard, the counts and the export."
                  : // Deleting the row outright would not stick: the next sync finds
                    // the repo on GitHub again and recreates it. Hiding does stick.
                    "For projects you have finished with. Deleting them off Vercel or GitHub does not take them out of this list, and a delete here would just come back on the next sync."}
              </span>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * A running note log for a project. Carl can type a note straight in, and the
 * assistant can drop notes here too — every entry is stamped with who wrote it
 * and the exact date and time, newest first.
 */
function NotesPanel({ projectId, notes }: { projectId: string; notes: GridNote[] }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function add() {
    const body = draft.trim();
    if (!body) return;
    setError(null);
    startTransition(async () => {
      const result = await addProjectNote(projectId, body);
      if (result.ok) {
        setDraft("");
        router.refresh();
      } else {
        setError(result.error ?? "Could not save note");
      }
    });
  }

  function remove(noteId: string) {
    startTransition(async () => {
      await deleteProjectNote(noteId);
      router.refresh();
    });
  }

  return (
    <div className="mt-5 border-t border-neutral-200 pt-3 dark:border-neutral-700">
      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Notes</div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter saves without reaching for the mouse.
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Add a note — a reminder, something from a client call…"
          rows={2}
          className="w-full resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs outline-none placeholder:text-neutral-400 focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-800 dark:bg-neutral-900 sm:max-w-md"
        />
        <button
          onClick={add}
          disabled={pending || draft.trim().length === 0}
          className="shrink-0 rounded-lg bg-[var(--brand)] px-3 py-2 text-xs font-medium text-white transition hover:opacity-85 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Add note"}
        </button>
      </div>
      {error ? <div className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}

      {notes.length === 0 ? (
        <div className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          No notes yet.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {notes.map((note) => (
            <li
              key={note.id}
              className="group rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      note.author === "ASSISTANT"
                        ? "bg-[var(--brand-2-soft)] text-[var(--brand-2-text)]"
                        : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                    }`}
                  >
                    {note.author === "ASSISTANT" ? "Claude" : "Carl"}
                  </span>
                  <span suppressHydrationWarning>{formatDateTime(note.createdAt)}</span>
                </div>
                <button
                  onClick={() => remove(note.id)}
                  disabled={pending}
                  aria-label="Delete note"
                  className="text-xs text-neutral-300 opacity-0 transition hover:text-red-500 group-hover:opacity-100 disabled:opacity-50 dark:text-neutral-600"
                >
                  ✕
                </button>
              </div>
              <div className="mt-1 whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-200">
                {note.body}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Compact local date, e.g. "28 Jul 2026" — for the grid's Deployed column. */
function formatDate(date: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

/** Local date + time, e.g. "28 Jul 2026, 14:05" — for note stamps and tooltips. */
function formatDateTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${formatDate(date)}, ${hh}:${mm}`;
}

function CountButton({ count, onClick }: { count: number; onClick: () => void }) {
  if (count === 0) return <span className="text-neutral-400">—</span>;
  return (
    <button
      onClick={onClick}
      className="rounded px-1.5 py-0.5 tabular-nums underline decoration-dotted underline-offset-2 transition hover:bg-[var(--brand-soft)] hover:text-[var(--brand-text)]"
    >
      {count}
    </button>
  );
}

/**
 * Three states, cycled by clicking: inheriting detection, forced on, forced off.
 * A ring marks the cell as manually overridden so it's obvious which numbers
 * came from the sync and which came from Carl.
 */
function CapabilityCell({
  auto,
  override,
  signals,
  onClick,
}: {
  auto: boolean;
  override: boolean | null;
  signals: { evidence: string; source: string }[];
  onClick: () => void;
}) {
  const value = override ?? auto;
  const isOverridden = override !== null;

  const title = isOverridden
    ? `Manually set to ${value ? "yes" : "no"} — click to cycle`
    : signals.length > 0
      ? `Detected from: ${signals.map((s) => s.evidence).join(", ")}`
      : "Not detected — click to set manually";

  return (
    <button
      onClick={onClick}
      title={title}
      className={`h-6 w-6 rounded-full text-xs font-semibold transition ${
        value
          ? "bg-[var(--brand-2-soft)] text-[var(--brand-2-text)]"
          : "bg-neutral-100 text-neutral-400 dark:bg-neutral-800 dark:text-neutral-600"
      } ${isOverridden ? "ring-2 ring-[var(--brand)]" : ""}`}
    >
      {value ? "✓" : "–"}
    </button>
  );
}

function OrgSelect({
  value,
  organizations,
  placeholder,
  onChange,
}: {
  value: string | null;
  organizations: Org[];
  placeholder: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      // No max width: the select fills whatever the Client / Customer column has
      // been dragged to, so widening the column actually reveals the name.
      title={organizations.find((org) => org.id === value)?.name ?? placeholder}
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-neutral-300 focus:border-neutral-400 dark:hover:border-neutral-600"
    >
      <option value="">{placeholder}</option>
      {organizations.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}

function DetailList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: { id: string; primary: string; secondary?: string }[];
}) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{title}</div>
      {items.length === 0 ? (
        <div className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">{empty}</div>
      ) : (
        <ul className="mt-2 space-y-1">
          {items.map((item) => (
            <li key={item.id} className="text-xs">
              <span className="font-medium">{item.primary}</span>
              {item.secondary ? (
                <span className="ml-1.5 text-neutral-400 dark:text-neutral-500">
                  {item.secondary}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
