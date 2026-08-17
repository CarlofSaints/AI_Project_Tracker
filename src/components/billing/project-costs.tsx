"use client";

/**
 * Cost per project for the period, most expensive first.
 *
 * This is the view that answers "what is this project actually costing me",
 * independent of who gets billed for it — so it deliberately includes projects
 * with no client, marked as such, rather than hiding them behind the invoice.
 */

import { Fragment, useState } from "react";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd, formatLocal, formatQuantity } from "@/lib/billing/format";

export function ProjectCosts({ rollup }: { rollup: PeriodRollup }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const all = [...rollup.projects, ...rollup.unassigned].sort((a, b) => b.costUsd - a.costUsd);
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? all.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          (project.clientName ?? "").toLowerCase().includes(needle) ||
          (project.endCustomerName ?? "").toLowerCase().includes(needle),
      )
    : all;

  if (all.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Cost by project</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          No project-level cost collected for {rollup.period.display}.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 p-5 dark:border-neutral-800">
        <div>
          <h2 className="text-base font-semibold">Cost by project</h2>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {all.length} project{all.length === 1 ? "" : "s"} with metered spend this month.
          </p>
        </div>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by project, client or customer"
          className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wide text-neutral-500">
          <tr className="border-b border-neutral-200 dark:border-neutral-800">
            <th className="px-5 py-2 font-medium">Project</th>
            <th className="px-5 py-2 font-medium">Client (you invoice)</th>
            <th className="px-5 py-2 font-medium">End customer (work is for)</th>
            <th className="px-5 py-2 font-medium">Vendors</th>
            <th className="px-5 py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {shown.map((project) => {
            const isOpen = expanded === project.projectId;
            return (
              // A row and its detail row are siblings in one tbody, so the key
              // has to live on a Fragment rather than on either <tr>.
              <Fragment key={project.projectId}>
                <tr
                  onClick={() => setExpanded(isOpen ? null : project.projectId)}
                  className="cursor-pointer transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  <td className="px-5 py-2.5 font-medium">
                    <span
                      aria-hidden
                      className={`mr-1.5 inline-block text-neutral-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
                    >
                      ›
                    </span>
                    {project.name}
                  </td>
                  <td className="px-5 py-2.5">
                    {project.clientName ? (
                      <span className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--brand-text)]">
                        {project.clientName}
                      </span>
                    ) : (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        no client
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    {project.endCustomerName ? (
                      <span className="rounded bg-[var(--brand-2-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--brand-2-text)]">
                        {project.endCustomerName}
                      </span>
                    ) : (
                      <span className="text-xs text-neutral-400">—</span>
                    )}
                  </td>
                  <td className="px-5 py-2.5">
                    <span className="flex flex-wrap gap-1">
                      {project.byVendor.map((vendor) => (
                        <span
                          key={vendor.vendor}
                          className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                        >
                          {vendor.vendorLabel} {formatUsd(vendor.costUsd)}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="px-5 py-2.5 text-right font-semibold tabular-nums">
                    {formatUsd(project.costUsd)}
                    {rollup.period.usdToZar !== null ? (
                      <div className="text-[11px] font-normal text-neutral-500">
                        {formatLocal(project.costUsd * rollup.period.usdToZar, rollup.currency)}
                      </div>
                    ) : null}
                  </td>
                </tr>
                {isOpen ? (
                  <tr className="bg-neutral-50 dark:bg-neutral-950/40">
                    <td colSpan={5} className="px-5 py-3">
                      <table className="w-full text-xs">
                        <thead className="text-left text-neutral-500">
                          <tr>
                            <th className="py-1 font-medium w-24">Vendor</th>
                            <th className="py-1 font-medium">Service</th>
                            <th className="py-1 text-right font-medium">Used</th>
                            <th className="py-1 text-right font-medium w-24">Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {project.services.map((service, index) => (
                            <tr
                              key={`${service.vendor}-${service.service}-${index}`}
                              className="text-neutral-600 dark:text-neutral-400"
                            >
                              <td className="py-1">{service.vendorLabel}</td>
                              <td className="py-1">{service.service}</td>
                              <td className="py-1 text-right tabular-nums">
                                {formatQuantity(service.quantity, service.unit)}
                              </td>
                              <td className="py-1 text-right tabular-nums">
                                {formatUsd(service.costUsd)}
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
        </tbody>
      </table>
    </section>
  );
}
