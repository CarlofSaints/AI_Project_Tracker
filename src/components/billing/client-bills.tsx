"use client";

/**
 * What each client owes — the shape an invoice line would take.
 *
 * Cost and markup are always shown side by side rather than collapsed into a
 * single billable figure. The number you charge and the number you paid are
 * different facts, and a screen that only shows the first makes it impossible
 * to notice a project quietly eating its own margin.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd, formatLocal, formatQuantity, formatPercent } from "@/lib/billing/format";
import { setClientMarkup } from "@/app/billing/actions";

export function ClientBills({
  rollup,
  organizations,
}: {
  rollup: PeriodRollup;
  organizations: Array<{ id: string; name: string; markupBasisPoints: number | null }>;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (rollup.clients.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Client bills</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Nothing to bill for {rollup.period.display} yet. Collect costs, then assign a client to
          each project on the dashboard.
        </p>
      </section>
    );
  }

  const ownMarkup = new Map(organizations.map((org) => [org.id, org.markupBasisPoints]));

  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-baseline justify-between gap-4 border-b border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-base font-semibold">Client bills — {rollup.period.display}</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            Direct project cost plus each client&rsquo;s share of the shared fees, with markup
            applied.
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums">
            {formatUsd(rollup.totals.billableUsd)}
          </div>
          {rollup.totals.billableLocal !== null ? (
            <div className="text-xs text-neutral-500">
              {formatLocal(rollup.totals.billableLocal, rollup.currency)}
            </div>
          ) : null}
        </div>
      </div>

      <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
        {rollup.clients.map((client) => {
          const isOpen = expanded === client.clientId;
          return (
            <li key={client.clientId}>
              <div className="flex flex-wrap items-center gap-3 px-5 py-3">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : client.clientId)}
                  className="flex flex-1 items-center gap-2 text-left"
                >
                  <span
                    aria-hidden
                    className={`text-neutral-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                  >
                    ›
                  </span>
                  <span className="font-medium">{client.name}</span>
                  <span className="text-xs text-neutral-500">
                    {client.projects.length} project{client.projects.length === 1 ? "" : "s"}
                  </span>
                </button>

                <MarkupEditor
                  clientId={client.clientId}
                  effective={client.markupBasisPoints}
                  own={ownMarkup.get(client.clientId) ?? null}
                  houseDefault={rollup.defaultMarkupBasisPoints}
                  frozen={rollup.period.closed}
                />

                <div className="w-28 text-right text-sm tabular-nums text-neutral-500">
                  {formatUsd(client.costUsd)}
                  <div className="text-[11px] text-neutral-400">cost</div>
                </div>
                <div className="w-32 text-right">
                  <div className="font-semibold tabular-nums">{formatUsd(client.billableUsd)}</div>
                  {client.billableLocal !== null ? (
                    <div className="text-[11px] text-neutral-500">
                      {formatLocal(client.billableLocal, rollup.currency)}
                    </div>
                  ) : null}
                </div>
              </div>

              {isOpen ? (
                <div className="space-y-4 border-t border-neutral-100 bg-neutral-50 px-5 py-4 dark:border-neutral-800 dark:bg-neutral-950/40">
                  {client.projects.length > 0 ? (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                        Direct project cost — {formatUsd(client.directCostUsd)}
                        {(() => {
                          // One line naming every end customer the client is
                          // being billed for, so the invoice can be described
                          // without expanding each project.
                          const customers = [
                            ...new Set(
                              client.projects
                                .map((p) => p.endCustomerName)
                                .filter((name): name is string => Boolean(name)),
                            ),
                          ];
                          return customers.length > 0 ? (
                            <span className="ml-1 font-normal normal-case text-neutral-400">
                              · for {customers.join(", ")}
                            </span>
                          ) : null;
                        })()}
                      </h4>
                      <div className="mt-2 space-y-3">
                        {client.projects.map((project) => (
                          <div key={project.projectId}>
                            <div className="flex items-baseline justify-between gap-3">
                              <span className="text-sm font-medium">
                                {project.name}
                                {/* The client pays, but the end customer is the
                                    name they'll recognise on an invoice line. */}
                                {project.endCustomerName ? (
                                  <span className="ml-2 rounded bg-[var(--brand-2-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--brand-2-text)]">
                                    for {project.endCustomerName}
                                  </span>
                                ) : null}
                              </span>
                              <span className="text-sm tabular-nums">
                                {formatUsd(project.costUsd)}
                              </span>
                            </div>
                            <table className="mt-1 w-full text-xs">
                              <tbody>
                                {project.services.map((service, index) => (
                                  <tr
                                    key={`${service.vendor}-${service.service}-${index}`}
                                    className="text-neutral-600 dark:text-neutral-400"
                                  >
                                    <td className="py-0.5 pr-2 w-20 align-top">
                                      {service.vendorLabel}
                                    </td>
                                    <td className="py-0.5 pr-2 align-top">{service.service}</td>
                                    <td className="py-0.5 pr-2 text-right tabular-nums align-top">
                                      {formatQuantity(service.quantity, service.unit)}
                                    </td>
                                    <td className="py-0.5 text-right tabular-nums align-top w-20">
                                      {formatUsd(service.costUsd)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-neutral-500">
                      No project cost this month — this client only carries a share of the shared
                      fees.
                    </p>
                  )}

                  {client.sharedBreakdown.length > 0 ? (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                        Share of shared costs — {formatUsd(client.sharedCostUsd)}
                      </h4>
                      <table className="mt-1 w-full text-xs">
                        <tbody>
                          {client.sharedBreakdown.map((share) => (
                            <tr
                              key={share.vendor}
                              className="text-neutral-600 dark:text-neutral-400"
                            >
                              <td className="py-0.5">{share.vendorLabel}</td>
                              <td className="py-0.5 text-right tabular-nums">
                                {formatUsd(share.amountUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-neutral-200 pt-3 text-sm dark:border-neutral-800 sm:max-w-sm">
                    <dt className="text-neutral-500">Cost</dt>
                    <dd className="text-right tabular-nums">{formatUsd(client.costUsd)}</dd>
                    <dt className="text-neutral-500">
                      Markup {formatPercent(client.markupBasisPoints)}
                    </dt>
                    <dd className="text-right tabular-nums">{formatUsd(client.markupUsd)}</dd>
                    <dt className="font-medium">Billable</dt>
                    <dd className="text-right font-semibold tabular-nums">
                      {formatUsd(client.billableUsd)}
                    </dd>
                    {client.billableLocal !== null ? (
                      <>
                        <dt className="text-neutral-500">
                          In {rollup.currency} at {rollup.period.usdToZar?.toFixed(4)}
                        </dt>
                        <dd className="text-right font-semibold tabular-nums">
                          {formatLocal(client.billableLocal, rollup.currency)}
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function MarkupEditor({
  clientId,
  effective,
  own,
  houseDefault,
  frozen,
}: {
  clientId: string;
  effective: number;
  own: number | null;
  houseDefault: number;
  frozen: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(effective / 100));

  if (frozen) {
    return (
      <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
        {formatPercent(effective)} locked
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded bg-[var(--brand-soft)] px-2 py-0.5 text-xs font-medium text-[var(--brand-text)]"
        title={own === null ? `Inherits the house default (${formatPercent(houseDefault)})` : "Set for this client"}
      >
        {formatPercent(effective)}
        {own === null ? " (default)" : ""}
      </button>
    );
  }

  function save(next: number | null) {
    startTransition(async () => {
      await setClientMarkup(clientId, next);
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        step="0.5"
        min="0"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        className="w-16 rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 text-right text-xs tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
      />
      <span className="text-xs text-neutral-500">%</span>
      <button
        type="button"
        disabled={pending}
        onClick={() => save(Math.round((Number.parseFloat(value) || 0) * 100))}
        className="text-xs text-[var(--brand-text)] underline underline-offset-2"
      >
        save
      </button>
      {own !== null ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => save(null)}
          className="text-xs text-neutral-500 underline underline-offset-2"
          title="Fall back to the house default"
        >
          reset
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => setEditing(false)}
        className="text-xs text-neutral-400"
      >
        ×
      </button>
    </span>
  );
}
