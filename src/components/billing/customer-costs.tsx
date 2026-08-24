"use client";

/**
 * The month grouped by who the work was actually for.
 *
 * "Cost by project" answers what a project costs and "Client bills" answers who
 * pays. Neither answers "what did the Haier work come to", which is the question
 * asked when a client covers several end customers.
 *
 * Only direct project cost appears here. Subscriptions and seats are allocated
 * to a client, and there is no honest way to push a Pro seat down onto an end
 * customer, so they are stated as missing rather than spread around to make the
 * total match. A view that quietly invents a number is worse than a short one.
 */

import { Fragment, useState } from "react";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd, formatLocal } from "@/lib/billing/format";

export function CustomerCosts({ rollup }: { rollup: PeriodRollup }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const { customers, totals, period, currency } = rollup;

  if (customers.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Cost by end customer</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Nothing to group yet for {period.display}. Collect costs first.
        </p>
      </section>
    );
  }

  const totalBillable = customers.reduce((sum, c) => sum + c.billableUsd, 0);
  const impliedProjects = customers.reduce((sum, c) => sum + c.impliedProjectCount, 0);

  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-neutral-200 p-5 dark:border-neutral-800">
        <h2 className="text-base font-semibold">Cost by end customer</h2>
        <p className="mt-1 max-w-3xl text-sm text-neutral-500 dark:text-neutral-400">
          Who the work was for, rather than who pays for it. Marked up at each
          paying client&rsquo;s own rate, so a customer served through two clients on
          different terms still adds up to what you will invoice.
          {impliedProjects > 0 ? (
            <>
              {" "}
              {impliedProjects} project{impliedProjects === 1 ? " has" : "s have"} no end
              customer recorded, so the client is taken to be the end customer. Those are
              marked below.
            </>
          ) : null}
        </p>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <th className="px-5 py-2 font-medium">End customer</th>
            <th className="px-5 py-2 font-medium">Billed through</th>
            <th className="px-5 py-2 text-right font-medium">Projects</th>
            <th className="px-5 py-2 text-right font-medium">Direct cost</th>
            <th className="px-5 py-2 text-right font-medium">
              <span title="What you already invoice monthly across this customer's projects. Reference only — nothing is deducted.">
                Already billing (R)
              </span>
            </th>
            <th className="px-5 py-2 text-right font-medium">Billable</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {customers.map((customer) => {
            const key = customer.customerId;
            const isOpen = expanded === key;
            return (
              <Fragment key={key}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : key)}
                  className="cursor-pointer transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  <td className="px-5 py-2.5 font-medium">
                    <span
                      aria-hidden
                      className={`mr-1.5 inline-block text-neutral-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      ›
                    </span>
                    <span className="rounded bg-[var(--brand-2-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--brand-2-text)]">
                      {customer.name}
                    </span>
                    {customer.impliedProjectCount > 0 ? (
                      // The distinction matters: these projects have not been
                      // given an end customer, they are not companies that bill
                      // themselves. Counted, because a customer is routinely both.
                      <span
                        className="ml-1.5 text-[11px] text-neutral-400"
                        title="These projects record no end customer, so the client is assumed to be the end customer. Set one on the dashboard to make it explicit."
                      >
                        {customer.impliedProjectCount} of {customer.projects.length} assumed
                      </span>
                    ) : null}
                  </td>
                  <td className="px-5 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {customer.clientNames.map((name) => (
                        <span
                          key={name}
                          className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--brand-text)]"
                        >
                          {name}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums">
                    {customer.projects.length}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                    {formatUsd(customer.costUsd)}
                  </td>
                  <td className="px-5 py-2.5 text-right tabular-nums text-neutral-600 dark:text-neutral-400">
                    {customer.alreadyBilledZar === null
                      ? "—"
                      : formatLocal(customer.alreadyBilledZar, "ZAR")}
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold tabular-nums">
                    {formatUsd(customer.billableUsd)}
                    {customer.billableLocal !== null ? (
                      <div className="text-[11px] font-normal text-neutral-500">
                        {formatLocal(customer.billableLocal, currency)}
                      </div>
                    ) : null}
                  </td>
                </tr>

                {isOpen ? (
                  <tr className="bg-neutral-50 dark:bg-neutral-950/40">
                    <td colSpan={6} className="px-5 py-3">
                      <table className="w-full text-xs">
                        <thead className="text-left text-neutral-500">
                          <tr>
                            <th className="py-1 font-medium">Project</th>
                            <th className="py-1 font-medium">Billed to</th>
                            <th className="py-1 text-right font-medium w-32">
                              Already billing (R)
                            </th>
                            <th className="py-1 text-right font-medium w-24">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {customer.projects.map((project) => (
                            <tr key={project.projectId}>
                              <td className="py-1">{project.name}</td>
                              <td className="py-1 text-neutral-500">
                                {project.clientName ?? "— no client —"}
                              </td>
                              <td className="py-1 text-right tabular-nums text-neutral-500">
                                {project.alreadyBilledZar === null
                                  ? "—"
                                  : formatLocal(project.alreadyBilledZar, "ZAR")}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {formatUsd(project.costUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}

          <tr className="border-t-2 border-neutral-200 font-semibold dark:border-neutral-700">
            <td className="px-5 py-2.5">Total, direct cost only</td>
            <td />
            <td className="px-5 py-2.5 text-right tabular-nums">
              {customers.reduce((sum, c) => sum + c.projects.length, 0)}
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">
              {formatUsd(customers.reduce((sum, c) => sum + c.costUsd, 0))}
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">
              {totals.alreadyBilledZar === null
                ? "—"
                : formatLocal(totals.alreadyBilledZar, "ZAR")}
            </td>
            <td className="px-5 py-2.5 text-right tabular-nums">
              {formatUsd(totalBillable)}
            </td>
          </tr>
        </tbody>
      </table>

      {totals.sharedNotInCustomerView > 0 ? (
        // Said out loud, because the alternative is someone comparing this
        // against Client bills, finding a gap, and assuming a number went astray.
        <p className="border-t border-neutral-200 px-5 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          A further {formatUsd(totals.sharedNotInCustomerView)} of subscriptions and
          seats is allocated to clients rather than to any end customer, so it is not
          in this table. That is the whole difference between this view and Client
          bills.
        </p>
      ) : null}
    </section>
  );
}
