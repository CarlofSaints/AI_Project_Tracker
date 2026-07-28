"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cycleCapabilityOverride, updateProjectAssignment } from "@/app/actions";

type Capability = "EMAIL" | "SHAREPOINT" | "EXTERNAL_DATA";
type Stage = "DEVELOPMENT" | "LIVE_ITERATING" | "HANDED_OVER" | "ARCHIVED";

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
  envVarCount: number;
  domainCount: number;
  databaseCount: number;
  stage: Stage;
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
  const [, startTransition] = useTransition();
  const router = useRouter();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.name, p.gitRepo, p.gitOwner, p.vercelProjectName, p.client?.name, p.endCustomer?.name]
        .filter(Boolean)
        .some((field) => field!.toLowerCase().includes(q)),
    );
  }, [projects, query]);

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
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {filtered.length} of {projects.length}
        </span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full min-w-[1400px] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <th className="w-8 px-3 py-3" />
              <th className="px-3 py-3 font-medium">Project</th>
              <th className="px-3 py-3 font-medium">Owner / scope</th>
              <th className="px-3 py-3 font-medium">Repo</th>
              <th className="px-3 py-3 font-medium">Vercel</th>
              <th className="px-3 py-3 text-right font-medium">Env</th>
              <th className="px-3 py-3 text-right font-medium">Domains</th>
              <th className="px-3 py-3 text-right font-medium">DBs</th>
              <th className="px-3 py-3 font-medium">Client</th>
              <th className="px-3 py-3 font-medium">Customer</th>
              <th className="px-3 py-3 text-center font-medium">Email</th>
              <th className="px-3 py-3 text-center font-medium">SP</th>
              <th className="px-3 py-3 text-center font-medium">Ext. data</th>
              <th className="px-3 py-3 font-medium">Progress</th>
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
                  colSpan={14}
                  className="px-4 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400"
                >
                  {projects.length === 0
                    ? "No projects yet — hit “Sync now” to pull them from Vercel and GitHub."
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
      <tr className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-800/60 dark:hover:bg-neutral-800/40">
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
          <div className="font-medium">{p.name}</div>
          {p.productionUrl ? (
            <a
              href={`https://${p.productionUrl}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-neutral-500 hover:underline dark:text-neutral-400"
            >
              {p.productionUrl}
            </a>
          ) : null}
        </td>

        <td className="px-3 py-2">
          {p.gitOwner ? (
            <span
              className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
                p.gitOwnerType === "ORGANIZATION"
                  ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
                  : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
              title={p.gitOwnerType === "ORGANIZATION" ? "GitHub organisation" : "Personal account"}
            >
              {p.gitOwner}
            </span>
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          )}
          {p.vercelScopeName ? (
            <div className="mt-0.5 text-xs text-neutral-400 dark:text-neutral-500">
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
              className="font-mono text-xs hover:underline"
            >
              {p.gitRepo}
            </a>
          ) : (
            <span className="text-xs text-neutral-400">not on GitHub</span>
          )}
        </td>

        <td className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-400">
          {p.vercelProjectName ?? <span className="text-neutral-400">not deployed</span>}
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
          <td colSpan={14} className="px-12 py-4">
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
          </td>
        </tr>
      ) : null}
    </>
  );
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
      onChange={(e) => onChange(e.target.value || null)}
      className="w-full max-w-[160px] cursor-pointer rounded-md border border-transparent bg-transparent px-1.5 py-1 text-xs outline-none hover:border-neutral-300 focus:border-neutral-400 dark:hover:border-neutral-600"
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
