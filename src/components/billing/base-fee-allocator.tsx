"use client";

/**
 * Splitting each vendor's base fees across clients, by hand.
 *
 * Base fees — a Vercel Pro seat, a Resend plan minimum, a Copilot seat — are
 * caused by the business, not by any one project, so there is no honest formula
 * that divides them. Who is getting the value out of a seat is something Carl
 * knows and this codebase does not, so the split is an input.
 *
 * Two deliberate choices:
 *   * Shares are stored as basis points, not amounts. If the fee changes next
 *     month the intent ("a quarter of it is theirs") survives; a stored amount
 *     would silently become the wrong fraction.
 *   * A split that doesn't reach 100% is allowed and shown as absorbed. Being
 *     forced to allocate every cent would just produce a fake number, and the
 *     unallocated remainder is a real business figure — it is your margin
 *     giving way.
 */

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import type { Vendor } from "@/generated/prisma/enums";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd, formatLocal } from "@/lib/billing/format";
import { saveAllocations } from "@/app/billing/actions";

interface Row {
  key: string;
  clientId: string;
  /** Held as text so a half-typed "12." doesn't snap back to 12 mid-keystroke. */
  percent: string;
  note: string;
}

let rowSeq = 0;
function newKey() {
  rowSeq += 1;
  return `row-${rowSeq}`;
}

export function BaseFeeAllocator({
  rollup,
  organizations,
}: {
  rollup: PeriodRollup;
  organizations: Array<{ id: string; name: string }>;
}) {
  if (rollup.baseFees.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Shared costs</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          No base fees collected for {rollup.period.display} yet. Subscription and seat charges
          land here once costs are collected, ready to be split across clients.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div>
        <h2 className="text-base font-semibold">Shared costs — split by client</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Subscriptions and seats that no single project caused. Divide each one however you judge
          fair; anything you don&rsquo;t allocate is absorbed by the business.
        </p>
      </div>

      {rollup.baseFees.map((fee) => (
        <VendorAllocation
          key={fee.vendor}
          vendor={fee.vendor}
          vendorLabel={fee.vendorLabel}
          totalUsd={fee.costUsd}
          initial={fee.allocations.map((a) => ({
            key: newKey(),
            clientId: a.clientId,
            percent: String(a.shareBasisPoints / 100),
            note: a.note ?? "",
          }))}
          organizations={organizations}
          periodId={rollup.period.id}
          closed={rollup.period.closed}
          rate={rollup.period.usdToZar}
          currency={rollup.currency}
        />
      ))}
    </section>
  );
}

function VendorAllocation({
  vendor,
  vendorLabel,
  totalUsd,
  initial,
  organizations,
  periodId,
  closed,
  rate,
  currency,
}: {
  vendor: Vendor;
  vendorLabel: string;
  totalUsd: number;
  initial: Row[];
  organizations: Array<{ id: string; name: string }>;
  periodId: string;
  closed: boolean;
  rate: number | null;
  currency: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>(initial);
  const [mode, setMode] = useState<"percent" | "amount">("percent");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const allocatedPercent = useMemo(
    () => rows.reduce((sum, row) => sum + (Number.parseFloat(row.percent) || 0), 0),
    [rows],
  );
  const remainderPercent = 100 - allocatedPercent;
  const over = allocatedPercent > 100.0001;

  function update(key: string, patch: Partial<Row>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  /** Typing dollars is often more natural than typing percentages. */
  function setFromAmount(key: string, amountText: string) {
    const amount = Number.parseFloat(amountText);
    if (!Number.isFinite(amount) || totalUsd <= 0) {
      update(key, { percent: "" });
      return;
    }
    update(key, { percent: String(Math.round((amount / totalUsd) * 10000) / 100) });
  }

  function splitEvenly() {
    const used = rows.filter((row) => row.clientId);
    if (used.length === 0) return;
    const each = Math.floor(10000 / used.length) / 100;
    setRows((prev) =>
      prev.map((row) => (row.clientId ? { ...row, percent: String(each) } : row)),
    );
  }

  function save() {
    setMessage(null);
    startTransition(async () => {
      const result = await saveAllocations(
        periodId,
        vendor,
        rows
          .filter((row) => row.clientId)
          .map((row) => ({
            clientId: row.clientId,
            shareBasisPoints: Math.round((Number.parseFloat(row.percent) || 0) * 100),
            note: row.note,
          })),
      );
      setMessage(
        result.ok
          ? { tone: "ok", text: "Split saved." }
          : { tone: "bad", text: result.error ?? "Could not save" },
      );
      router.refresh();
    });
  }

  const taken = new Set(rows.map((row) => row.clientId).filter(Boolean));

  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h3 className="font-medium">{vendorLabel}</h3>
          <span className="text-lg font-semibold tabular-nums">{formatUsd(totalUsd)}</span>
          {rate !== null ? (
            <span className="text-xs text-neutral-500">
              {formatLocal(totalUsd * rate, currency)}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500">Enter as</span>
          <button
            type="button"
            onClick={() => setMode("percent")}
            className={`rounded px-2 py-1 ${mode === "percent" ? "bg-[var(--brand-soft)] text-[var(--brand-text)]" : "text-neutral-500"}`}
          >
            %
          </button>
          <button
            type="button"
            onClick={() => setMode("amount")}
            disabled={totalUsd <= 0}
            className={`rounded px-2 py-1 disabled:opacity-40 ${mode === "amount" ? "bg-[var(--brand-soft)] text-[var(--brand-text)]" : "text-neutral-500"}`}
          >
            $
          </button>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {rows.map((row) => {
          const percent = Number.parseFloat(row.percent) || 0;
          const amount = (totalUsd * percent) / 100;
          return (
            <div key={row.key} className="flex flex-wrap items-center gap-2">
              <select
                value={row.clientId}
                disabled={closed}
                onChange={(event) => update(row.key, { clientId: event.target.value })}
                className="min-w-48 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
              >
                <option value="">Choose a client…</option>
                {organizations
                  .filter((org) => org.id === row.clientId || !taken.has(org.id))
                  .map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
              </select>

              {mode === "percent" ? (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={row.percent}
                    disabled={closed}
                    onChange={(event) => update(row.key, { percent: event.target.value })}
                    className="w-24 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <span className="text-sm text-neutral-500">%</span>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <span className="text-sm text-neutral-500">$</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount ? amount.toFixed(2) : ""}
                    disabled={closed}
                    onChange={(event) => setFromAmount(row.key, event.target.value)}
                    className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
                  />
                </div>
              )}

              <span className="w-28 text-sm tabular-nums text-neutral-500">
                {mode === "percent" ? formatUsd(amount) : `${percent.toFixed(2)}%`}
              </span>

              <input
                type="text"
                value={row.note}
                disabled={closed}
                placeholder="Why this share (optional)"
                onChange={(event) => update(row.key, { note: event.target.value })}
                className="min-w-40 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
              />

              <button
                type="button"
                disabled={closed}
                onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
                className="px-1 text-neutral-400 transition hover:text-red-600 disabled:opacity-40"
                aria-label="Remove row"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={closed}
          onClick={() =>
            setRows((prev) => [...prev, { key: newKey(), clientId: "", percent: "", note: "" }])
          }
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          + Add client
        </button>
        <button
          type="button"
          disabled={closed || rows.length === 0}
          onClick={splitEvenly}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Split evenly
        </button>

        <span
          className={`ml-auto text-sm tabular-nums ${
            over ? "text-red-600 dark:text-red-400" : "text-neutral-500"
          }`}
        >
          {allocatedPercent.toFixed(2)}% allocated
          {over
            ? " — over 100%"
            : remainderPercent > 0.0001
              ? ` · ${formatUsd((totalUsd * remainderPercent) / 100)} absorbed by you`
              : " · fully allocated"}
        </span>

        <button
          type="button"
          disabled={pending || closed || over}
          onClick={save}
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save split"}
        </button>
      </div>

      {message ? (
        <p
          className={`mt-2 text-sm ${
            message.tone === "ok"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
