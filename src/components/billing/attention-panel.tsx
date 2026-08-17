"use client";

/**
 * Everything the billing page cannot answer on its own.
 *
 * Two failure modes matter here and they look identical on a total:
 *   * a vendor was never reached (no token, no permission, an outage)
 *   * a vendor reported spend against an identity we don't recognise
 *
 * Both show a smaller number than reality, so both are stated in full rather
 * than folded into the figures. The unmapped case is fixable inline, and
 * mapping repairs the lines already stored instead of waiting for a re-run.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Vendor } from "@/generated/prisma/enums";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd } from "@/lib/billing/format";
import { mapVendorAccount, unmapVendorAccount } from "@/app/billing/actions";

interface RunSummary {
  vendor: Vendor;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  linesWritten: number;
  costUsdTotal: number;
  unmapped: number;
  error: string | null;
  log: string | null;
}

interface LinkSummary {
  id: string;
  vendor: Vendor;
  externalId: string;
  externalLabel: string | null;
  projectName: string;
}

export function AttentionPanel({
  rollup,
  projects,
  runs,
  links,
}: {
  rollup: PeriodRollup;
  projects: Array<{ id: string; name: string }>;
  runs: RunSummary[];
  links: LinkSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const [showLog, setShowLog] = useState<Vendor | null>(null);
  const [showLinks, setShowLinks] = useState(false);

  const problemRuns = runs.filter((run) => run.status === "FAILED" || run.status === "PARTIAL");
  const hasUnattributed = rollup.unattributed.length > 0;
  const hasUnassigned = rollup.unassigned.length > 0;

  function map(vendor: Vendor, externalId: string, label: string) {
    const projectId = choice[`${vendor}|${externalId}`];
    if (!projectId) {
      setNote("Pick a project first.");
      return;
    }
    setNote(null);
    startTransition(async () => {
      const result = await mapVendorAccount(vendor, externalId, label, projectId);
      setNote(
        result.ok
          ? `Mapped. ${result.repaired} existing cost line${result.repaired === 1 ? "" : "s"} moved onto the project.`
          : (result.error ?? "Could not map that account"),
      );
      router.refresh();
    });
  }

  if (!hasUnattributed && !hasUnassigned && problemRuns.length === 0 && links.length === 0) {
    return null;
  }

  return (
    <section className="space-y-4 rounded-xl border border-amber-300 bg-amber-50/60 p-5 dark:border-amber-900 dark:bg-amber-950/30">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-semibold">Needs your attention</h2>
        {links.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowLinks((v) => !v)}
            className="text-xs text-neutral-600 underline underline-offset-2 dark:text-neutral-400"
          >
            {showLinks ? "Hide" : "Show"} {links.length} existing mapping
            {links.length === 1 ? "" : "s"}
          </button>
        ) : null}
      </div>

      {note ? <p className="text-sm text-neutral-700 dark:text-neutral-300">{note}</p> : null}

      {/* ----------------------------------------------- collectors that failed */}
      {problemRuns.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Collectors that did not report</h3>
          {problemRuns.map((run) => (
            <div
              key={run.vendor}
              className="rounded-md border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{run.vendor}</span>
                <span
                  className={`rounded px-1.5 py-0.5 text-xs ${
                    run.status === "FAILED"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : "bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200"
                  }`}
                >
                  {run.status === "PARTIAL" ? "not configured" : "failed"}
                </span>
              </div>
              {run.error ? (
                <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">{run.error}</p>
              ) : null}
              <p className="mt-1 text-xs text-neutral-500">
                Any spend at this vendor is missing from the figures below.
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {/* ------------------------------------------------- unmapped identities */}
      {hasUnattributed ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            Spend we cannot tie to a project ({formatUsd(rollup.totals.unattributedUsd)})
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            The vendor reported these against an account we don&rsquo;t recognise. Map each one and
            the cost moves onto the project immediately — no re-collection needed.
          </p>
          <div className="space-y-2">
            {rollup.unattributed.map((bucket) => {
              const key = `${bucket.vendor}|${bucket.unresolvedKey}`;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white p-3 text-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs font-medium dark:bg-neutral-800">
                    {bucket.vendorLabel}
                  </span>
                  <span className="font-mono text-xs">{bucket.unresolvedLabel}</span>
                  <span className="tabular-nums font-medium">{formatUsd(bucket.costUsd)}</span>
                  <span className="text-xs text-neutral-500">
                    {bucket.lineCount} line{bucket.lineCount === 1 ? "" : "s"} · e.g.{" "}
                    {bucket.sampleService}
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <select
                      value={choice[key] ?? ""}
                      onChange={(event) =>
                        setChoice((prev) => ({ ...prev, [key]: event.target.value }))
                      }
                      className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <option value="">Map to project…</option>
                      {projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        map(bucket.vendor, bucket.unresolvedKey, bucket.unresolvedLabel)
                      }
                      className="rounded-md bg-[var(--brand)] px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      Map
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------ projects with no client set */}
      {hasUnassigned ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            Projects with cost but no client ({formatUsd(rollup.totals.unassignedUsd)})
          </h3>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            These are attributed correctly but have nobody to bill. Assign a client on the
            dashboard and they roll into that client&rsquo;s invoice.
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {rollup.unassigned.map((project) => (
              <li
                key={project.projectId}
                className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
              >
                {project.name}{" "}
                <span className="tabular-nums font-medium">{formatUsd(project.costUsd)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ------------------------------------------------------ existing links */}
      {showLinks ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Vendor account mappings</h3>
          <ul className="space-y-1">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
              >
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium dark:bg-neutral-800">
                  {link.vendor}
                </span>
                <span className="font-mono">{link.externalLabel ?? link.externalId}</span>
                <span className="text-neutral-400">→</span>
                <span>{link.projectName}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      await unmapVendorAccount(link.vendor, link.externalId);
                      router.refresh();
                    })
                  }
                  className="ml-auto text-neutral-400 underline underline-offset-2 hover:text-red-600"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* --------------------------------------------------------- vendor logs */}
      {runs.length > 0 ? (
        <div className="space-y-1 border-t border-amber-200 pt-3 dark:border-amber-900">
          <div className="flex flex-wrap gap-1.5">
            {runs.map((run) => (
              <button
                key={run.vendor}
                type="button"
                onClick={() => setShowLog(showLog === run.vendor ? null : run.vendor)}
                className="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs dark:border-neutral-800 dark:bg-neutral-900"
              >
                {run.vendor}: {formatUsd(run.costUsdTotal)} · {run.linesWritten} lines
              </button>
            ))}
          </div>
          {showLog ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">
              {runs.find((r) => r.vendor === showLog)?.log ||
                runs.find((r) => r.vendor === showLog)?.error ||
                "No log recorded."}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
