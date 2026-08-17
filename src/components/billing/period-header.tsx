"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  collectCosts,
  closePeriod,
  reopenPeriod,
  refetchPeriodRate,
} from "@/app/billing/actions";
import { parsePeriodLabel, periodLabel } from "@/lib/billing/period";

export function PeriodHeader({
  periodLabel: label,
  display,
  closed,
  periodId,
  knownPeriods,
  hasRate,
}: {
  periodLabel: string;
  display: string;
  closed: boolean;
  periodId: string;
  knownPeriods: Array<{ label: string; closed: boolean }>;
  hasRate: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const parsed = parsePeriodLabel(label);

  function go(target: string) {
    router.push(`/billing?period=${target}`);
  }

  function shift(months: number) {
    if (!parsed) return;
    const base = new Date(Date.UTC(parsed.year, parsed.month - 1 + months, 1));
    go(periodLabel(base.getUTCFullYear(), base.getUTCMonth() + 1));
  }

  function run(
    action: () => Promise<{ ok: boolean; error?: string }>,
    okText: string,
  ) {
    setMessage(null);
    startTransition(async () => {
      const result = await action();
      setMessage(
        result.ok
          ? { tone: "ok", text: okText }
          : { tone: "bad", text: result.error ?? "Something went wrong" },
      );
      router.refresh();
    });
  }

  // The picker must offer months that have never been opened, otherwise there
  // is no way to reach a month before the first ingest ever ran.
  const options = new Set(knownPeriods.map((p) => p.label));
  options.add(label);
  const now = new Date();
  for (let back = 0; back < 18; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    options.add(periodLabel(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  const sorted = [...options].sort().reverse();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
            {closed ? (
              <span className="rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                Closed
              </span>
            ) : (
              <span className="rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-xs font-medium text-[var(--brand-text)]">
                Open
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Third-party cost for {display}, attributed to projects and rolled up per client.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => shift(-1)}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              aria-label="Previous month"
            >
              ←
            </button>
            <select
              value={label}
              onChange={(event) => go(event.target.value)}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {sorted.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => shift(1)}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
              aria-label="Next month"
            >
              →
            </button>
          </div>

          {!hasRate && !closed ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => refetchPeriodRate(periodId), "Exchange rate set.")}
              className="rounded-md border border-amber-400 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50 dark:text-amber-400 dark:hover:bg-amber-950"
            >
              Fetch rate
            </button>
          ) : null}

          <button
            type="button"
            disabled={pending || closed}
            onClick={() => run(() => collectCosts(label), "Collection finished.")}
            className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {pending ? "Working…" : "Collect costs"}
          </button>

          {/* A plain link, not a fetch: the browser reuses its Basic-auth
              credentials, which an XHR carrying no header would not. */}
          <a
            href={`/api/billing/export?period=${label}`}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Export
          </a>

          {closed ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => reopenPeriod(periodId), "Period re-opened.")}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Re-open
            </button>
          ) : (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => closePeriod(periodId), "Period closed and markups frozen.")
              }
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              Close month
            </button>
          )}
        </div>
      </div>

      {message ? (
        <p
          className={`text-sm ${
            message.tone === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      {closed ? (
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          This month is frozen: the exchange rate and every client&rsquo;s markup are locked to
          what they were at close, so an invoice you have already sent cannot move. Re-open it to
          correct something.
        </p>
      ) : null}
    </div>
  );
}
