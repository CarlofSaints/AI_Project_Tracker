/**
 * The rollup engine — the single source of truth for every number the billing
 * module shows.
 *
 * The page, the per-client invoice view and the Excel export all read from
 * here, for the same reason the project grid and its export both read from
 * grid-view.ts: the moment two code paths compute a total, they eventually
 * disagree, and the one you didn't check is the one the client sees.
 *
 * Nothing here is persisted. Project totals, client totals, markup and rand
 * figures are all derived from CostLine + SharedCostAllocation + the period's
 * rate on every read, so correcting an allocation or a mapping is immediately
 * reflected everywhere. Closing a period freezes the *inputs* instead — the
 * rate and each client's markup — which is what keeps a sent invoice stable
 * without ever storing a stale copy of the answer.
 *
 * Money: everything is USD internally, rounded to cents only at the point a
 * figure is presented as an amount. Local-currency figures are derived from the
 * one rate stored on the period, never a live one.
 */

import { prisma } from "@/lib/db";
import type { Vendor } from "@/generated/prisma/enums";
import { VENDOR_LABELS } from "./types";
import { periodDisplay } from "./period";
import { round2 } from "./format";

// Re-exported so server callers can pull the rollup and its formatters from one
// place, while client components import them from ./format directly.
export {
  round2,
  basisPointsToPercent,
  formatUsd,
  formatLocal,
  formatQuantity,
  formatPercent,
} from "./format";

export interface ServiceLine {
  vendor: Vendor;
  vendorLabel: string;
  service: string;
  quantity: number | null;
  unit: string | null;
  costUsd: number;
}

export interface ProjectCost {
  projectId: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  /**
   * Who the work was actually for. Carried all the way through to the invoice
   * because "iRam owes $40" is not a billable line — "iRam owes $40, for
   * SnoMaster" is. The client pays; the end customer is what they recognise.
   */
  endCustomerId: string | null;
  endCustomerName: string | null;
  costUsd: number;
  /**
   * What is already invoiced monthly for this project, in ZAR. Reference only:
   * never netted off, so a figure entered here can never quietly reduce a bill.
   * Frozen at the value it held when the period closed.
   */
  alreadyBilledZar: number | null;
  byVendor: Array<{ vendor: Vendor; vendorLabel: string; costUsd: number }>;
  services: ServiceLine[];
}

export interface UnattributedBucket {
  vendor: Vendor;
  vendorLabel: string;
  unresolvedKey: string;
  unresolvedLabel: string;
  costUsd: number;
  lineCount: number;
  sampleService: string;
}

export interface VendorBaseFee {
  vendor: Vendor;
  vendorLabel: string;
  costUsd: number;
  allocatedBasisPoints: number;
  allocations: Array<{
    clientId: string;
    clientName: string;
    shareBasisPoints: number;
    amountUsd: number;
    note: string | null;
  }>;
  absorbedUsd: number;
}

export interface ClientBill {
  clientId: string;
  name: string;
  projects: ProjectCost[];
  directCostUsd: number;
  sharedCostUsd: number;
  sharedBreakdown: Array<{ vendor: Vendor; vendorLabel: string; amountUsd: number }>;
  costUsd: number;
  markupBasisPoints: number;
  markupUsd: number;
  billableUsd: number;
  billableLocal: number | null;
  /** Standing monthly invoicing already in place across this client's projects. */
  alreadyBilledZar: number | null;
}

/**
 * The same month grouped by who the work was actually for.
 *
 * Only DIRECT project cost rolls up here. Shared base fees are allocated to
 * clients, not customers, and there is no honest way to push a Pro seat down
 * onto an end customer — so they are deliberately absent rather than spread
 * around to make a total look complete. See `totals.sharedNotInCustomerView`.
 */
export interface CustomerRollup {
  customerId: string;
  name: string;
  /**
   * How many of this customer's projects reached it by assumption rather than by
   * a recorded end customer. Where nothing is recorded the client IS the end
   * customer, which is a real answer but a derived one.
   *
   * Counted rather than flagged because a company is routinely both: iRam is the
   * recorded end customer on three projects and the unnamed one on ten. Splitting
   * it into two rows over that would turn a data-entry gap into two companies.
   */
  impliedProjectCount: number;
  /** Every client that invoices for work done for this customer. */
  clientNames: string[];
  projects: ProjectCost[];
  costUsd: number;
  markupUsd: number;
  billableUsd: number;
  billableLocal: number | null;
  alreadyBilledZar: number | null;
}

export interface PeriodRollup {
  period: {
    id: string;
    year: number;
    month: number;
    label: string;
    display: string;
    closed: boolean;
    usdToZar: number | null;
    rateSource: string | null;
    rateSetAt: Date | null;
  };
  currency: string;
  defaultMarkupBasisPoints: number;
  /** Projects with a client, most expensive first. */
  projects: ProjectCost[];
  /** The same direct cost grouped by the company the work was for. */
  customers: CustomerRollup[];
  /** Projects carrying cost but no client — revenue you are not billing for. */
  unassigned: ProjectCost[];
  unattributed: UnattributedBucket[];
  baseFees: VendorBaseFee[];
  clients: ClientBill[];
  totals: {
    meteredUsd: number;
    baseFeeUsd: number;
    /** Metered cost sitting on projects with no client. */
    unassignedUsd: number;
    /** Metered cost whose project could not be identified at all. */
    unattributedUsd: number;
    costUsd: number;
    allocatedBaseFeeUsd: number;
    absorbedBaseFeeUsd: number;
    billableUsd: number;
    billableLocal: number | null;
    marginUsd: number;
    /** Standing monthly invoicing across every project that has a figure. */
    alreadyBilledZar: number | null;
    /**
     * Shared base fees that the customer view cannot show, because they belong
     * to a client rather than to any end customer. Stated so the two views can
     * be reconciled instead of looking like one of them lost money.
     */
    sharedNotInCustomerView: number;
  };
}

const ZERO_ROLLUP_VENDORS: Vendor[] = [
  "VERCEL",
  "GITHUB",
  "ANTHROPIC",
  "RESEND",
  "GOOGLE",
  "OTHER",
];

export async function buildPeriodRollup(periodId: string): Promise<PeriodRollup | null> {
  const period = await prisma.billingPeriod.findUnique({ where: { id: periodId } });
  if (!period) return null;

  const [settings, lines, allocations, terms, projectTerms, organizations] = await Promise.all([
    prisma.billingSettings.findUnique({ where: { id: "singleton" } }),
    prisma.costLine.findMany({
      where: { periodId },
      include: {
        project: {
          select: {
            id: true,
            name: true,
            clientId: true,
            client: { select: { id: true, name: true } },
            endCustomerId: true,
            endCustomer: { select: { id: true, name: true } },
            alreadyBilledZar: true,
          },
        },
      },
    }),
    prisma.sharedCostAllocation.findMany({
      where: { periodId },
      include: { client: { select: { id: true, name: true } } },
    }),
    prisma.clientPeriodTerms.findMany({ where: { periodId } }),
    prisma.projectPeriodTerms.findMany({ where: { periodId } }),
    prisma.organization.findMany({ select: { id: true, name: true, markupBasisPoints: true } }),
  ]);

  // A closed period says what it said when it closed. An open one follows the
  // standing figure, so changing a retainer is reflected without re-keying it.
  const frozenAlreadyBilled = new Map(
    projectTerms.map((t) => [t.projectId, Number(t.alreadyBilledZar)]),
  );

  function alreadyBilledFor(project: { id: string; alreadyBilledZar: unknown }): number | null {
    const frozen = frozenAlreadyBilled.get(project.id);
    if (frozen !== undefined) return frozen;
    return project.alreadyBilledZar === null || project.alreadyBilledZar === undefined
      ? null
      : Number(project.alreadyBilledZar);
  }

  /** Sum that stays null when nothing was entered, rather than reading as R0. */
  function sumAlreadyBilled(items: Array<{ alreadyBilledZar: number | null }>): number | null {
    const present = items.filter((i) => i.alreadyBilledZar !== null);
    if (present.length === 0) return null;
    return round2(present.reduce((sum, i) => sum + (i.alreadyBilledZar ?? 0), 0));
  }

  const currency = settings?.billingCurrency ?? "ZAR";
  const defaultMarkup = settings?.defaultMarkupBasisPoints ?? 1500;
  const rate = period.usdToZar ? Number(period.usdToZar) : null;

  // ------------------------------------------------------- metered by project
  const projectMap = new Map<string, ProjectCost>();
  const unattributedMap = new Map<string, UnattributedBucket>();
  /** Largest single line seen per bucket, so the example names the real cost. */
  const sampleCost = new Map<string, number>();
  const baseFeeTotals = new Map<Vendor, number>();

  let meteredUsd = 0;
  let baseFeeUsd = 0;

  for (const line of lines) {
    const cost = Number(line.costUsd);
    const vendorLabel =
      line.vendor === "OTHER" && line.vendorLabel ? line.vendorLabel : VENDOR_LABELS[line.vendor];

    if (line.kind === "BASE_FEE") {
      baseFeeUsd += cost;
      baseFeeTotals.set(line.vendor, (baseFeeTotals.get(line.vendor) ?? 0) + cost);
      continue;
    }

    meteredUsd += cost;

    if (!line.project) {
      // Metered but unattributed. Bucketed by the vendor identity we kept on
      // the row, so the UI can offer a one-click mapping.
      const key = `${line.vendor}|${line.unresolvedKey ?? "unknown"}`;
      const bucket = unattributedMap.get(key) ?? {
        vendor: line.vendor,
        vendorLabel,
        unresolvedKey: line.unresolvedKey ?? "unknown",
        unresolvedLabel: line.unresolvedLabel ?? line.unresolvedKey ?? "Unidentified",
        costUsd: 0,
        lineCount: 0,
        sampleService: line.service,
      };
      bucket.costUsd += cost;
      bucket.lineCount += 1;

      // The example service has to be the one carrying the money. Taking the
      // first line seen labelled a $26.42 bucket "e.g. Observability Plus" — a
      // line that cost exactly nothing — while the actual spend was the Pro
      // seats. An example that points away from the money is worse than none.
      const best = sampleCost.get(key) ?? -1;
      if (cost > best) {
        sampleCost.set(key, cost);
        bucket.sampleService = line.service;
      }

      unattributedMap.set(key, bucket);
      continue;
    }

    const entry = projectMap.get(line.project.id) ?? {
      projectId: line.project.id,
      name: line.project.name,
      clientId: line.project.clientId,
      clientName: line.project.client?.name ?? null,
      endCustomerId: line.project.endCustomerId,
      endCustomerName: line.project.endCustomer?.name ?? null,
      costUsd: 0,
      alreadyBilledZar: alreadyBilledFor(line.project),
      byVendor: [],
      services: [],
    };

    entry.costUsd += cost;

    const vendorSlot = entry.byVendor.find((v) => v.vendor === line.vendor);
    if (vendorSlot) vendorSlot.costUsd += cost;
    else entry.byVendor.push({ vendor: line.vendor, vendorLabel, costUsd: cost });

    // Collapse a month of daily rows into one line per service, which is what
    // anyone actually wants to read on an invoice.
    const serviceSlot = entry.services.find(
      (s) => s.vendor === line.vendor && s.service === line.service && s.unit === line.unit,
    );
    if (serviceSlot) {
      serviceSlot.costUsd += cost;
      if (line.quantity !== null) {
        serviceSlot.quantity = (serviceSlot.quantity ?? 0) + Number(line.quantity);
      }
    } else {
      entry.services.push({
        vendor: line.vendor,
        vendorLabel,
        service: line.service,
        quantity: line.quantity === null ? null : Number(line.quantity),
        unit: line.unit,
        costUsd: cost,
      });
    }

    projectMap.set(line.project.id, entry);
  }

  for (const project of projectMap.values()) {
    project.byVendor.sort((a, b) => b.costUsd - a.costUsd);
    project.services.sort((a, b) => b.costUsd - a.costUsd || a.service.localeCompare(b.service));
  }

  const allProjects = [...projectMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const projects = allProjects.filter((p) => p.clientId);
  const unassigned = allProjects.filter((p) => !p.clientId);

  // ------------------------------------------------------------- base fees
  const orgById = new Map(organizations.map((o) => [o.id, o]));

  const baseFees: VendorBaseFee[] = ZERO_ROLLUP_VENDORS.filter((vendor) =>
    baseFeeTotals.has(vendor),
  ).map((vendor) => {
    const total = baseFeeTotals.get(vendor) ?? 0;
    const forVendor = allocations.filter((a) => a.vendor === vendor);
    const allocatedBasisPoints = forVendor.reduce((sum, a) => sum + a.shareBasisPoints, 0);

    return {
      vendor,
      vendorLabel: VENDOR_LABELS[vendor],
      costUsd: total,
      allocatedBasisPoints,
      allocations: forVendor
        .map((a) => ({
          clientId: a.clientId,
          clientName: a.client?.name ?? orgById.get(a.clientId)?.name ?? "Unknown",
          shareBasisPoints: a.shareBasisPoints,
          amountUsd: (total * a.shareBasisPoints) / 10000,
          note: a.note,
        }))
        .sort((a, b) => b.amountUsd - a.amountUsd),
      // Anything not allocated is absorbed by the business. Shown, not hidden —
      // an under-allocated month is a margin decision, not an error.
      absorbedUsd: (total * Math.max(0, 10000 - allocatedBasisPoints)) / 10000,
    };
  });

  // -------------------------------------------------------------- clients
  const termsByClient = new Map(terms.map((t) => [t.clientId, t.markupBasisPoints]));

  function effectiveMarkup(clientId: string): number {
    const frozen = termsByClient.get(clientId);
    if (frozen !== undefined) return frozen;
    const own = orgById.get(clientId)?.markupBasisPoints;
    return own ?? defaultMarkup;
  }

  const clientIds = new Set<string>();
  for (const project of projects) if (project.clientId) clientIds.add(project.clientId);
  for (const fee of baseFees) for (const a of fee.allocations) clientIds.add(a.clientId);

  const clients: ClientBill[] = [...clientIds]
    .map((clientId) => {
      const clientProjects = projects.filter((p) => p.clientId === clientId);
      const directCostUsd = clientProjects.reduce((sum, p) => sum + p.costUsd, 0);

      const sharedBreakdown = baseFees
        .map((fee) => {
          const share = fee.allocations.find((a) => a.clientId === clientId);
          return {
            vendor: fee.vendor,
            vendorLabel: fee.vendorLabel,
            amountUsd: share?.amountUsd ?? 0,
          };
        })
        .filter((s) => s.amountUsd !== 0);

      const sharedCostUsd = sharedBreakdown.reduce((sum, s) => sum + s.amountUsd, 0);
      const costUsd = directCostUsd + sharedCostUsd;
      const markupBasisPoints = effectiveMarkup(clientId);
      const billableUsd = round2(costUsd * (1 + markupBasisPoints / 10000));

      return {
        clientId,
        name:
          orgById.get(clientId)?.name ??
          clientProjects[0]?.clientName ??
          "Unknown client",
        projects: clientProjects,
        directCostUsd,
        sharedCostUsd,
        sharedBreakdown,
        costUsd,
        markupBasisPoints,
        markupUsd: round2(billableUsd - costUsd),
        billableUsd,
        billableLocal: rate === null ? null : round2(billableUsd * rate),
        alreadyBilledZar: sumAlreadyBilled(clientProjects),
      };
    })
    .sort((a, b) => b.billableUsd - a.billableUsd);

  // ------------------------------------------------------------- customers
  // Grouped by who the work was for. A project with no end customer recorded is
  // filed under its client, because when nobody else is named the client IS the
  // end customer — but flagged, so a blank field is never mistaken for a fact.
  const customerMap = new Map<string, CustomerRollup>();

  for (const project of projects) {
    const recorded = project.endCustomerId !== null;
    const customerId = project.endCustomerId ?? project.clientId;
    const name = recorded ? project.endCustomerName : project.clientName;
    if (!customerId || !name) continue;

    // Keyed on the company alone. A customer reached both ways is one customer.
    const entry = customerMap.get(customerId) ?? {
      customerId,
      name,
      impliedProjectCount: 0,
      clientNames: [],
      projects: [],
      costUsd: 0,
      markupUsd: 0,
      billableUsd: 0,
      billableLocal: null,
      alreadyBilledZar: null,
    };

    entry.projects.push(project);
    entry.costUsd += project.costUsd;
    if (!recorded) entry.impliedProjectCount += 1;
    if (project.clientName && !entry.clientNames.includes(project.clientName)) {
      entry.clientNames.push(project.clientName);
    }
    customerMap.set(customerId, entry);
  }

  const customers = [...customerMap.values()]
    .map((entry) => {
      // Marked up at each paying client's own rate, so a customer served through
      // two clients on different terms still adds up to what will be invoiced.
      const billableUsd = round2(
        entry.projects.reduce(
          (sum, p) =>
            sum + p.costUsd * (1 + (p.clientId ? effectiveMarkup(p.clientId) : defaultMarkup) / 10000),
          0,
        ),
      );
      entry.costUsd = round2(entry.costUsd);
      entry.markupUsd = round2(billableUsd - entry.costUsd);
      entry.billableUsd = billableUsd;
      entry.billableLocal = rate === null ? null : round2(billableUsd * rate);
      entry.alreadyBilledZar = sumAlreadyBilled(entry.projects);
      entry.clientNames.sort((a, b) => a.localeCompare(b));
      return entry;
    })
    .sort((a, b) => b.billableUsd - a.billableUsd || a.name.localeCompare(b.name));

  // --------------------------------------------------------------- totals
  const unattributed = [...unattributedMap.values()].sort((a, b) => b.costUsd - a.costUsd);
  const unattributedUsd = unattributed.reduce((sum, u) => sum + u.costUsd, 0);
  const unassignedUsd = unassigned.reduce((sum, p) => sum + p.costUsd, 0);
  const allocatedBaseFeeUsd = baseFees.reduce(
    (sum, fee) => sum + (fee.costUsd - fee.absorbedUsd),
    0,
  );
  const absorbedBaseFeeUsd = baseFees.reduce((sum, fee) => sum + fee.absorbedUsd, 0);
  // Totals are the sum of the per-client rounded figures, so the page adds up
  // to exactly what the invoices say.
  const billableUsd = round2(clients.reduce((sum, c) => sum + c.billableUsd, 0));
  const costUsd = meteredUsd + baseFeeUsd;

  return {
    period: {
      id: period.id,
      year: period.year,
      month: period.month,
      label: period.label,
      display: periodDisplay(period.year, period.month),
      closed: period.closed,
      usdToZar: rate,
      rateSource: period.rateSource,
      rateSetAt: period.rateSetAt,
    },
    currency,
    defaultMarkupBasisPoints: defaultMarkup,
    projects,
    customers,
    unassigned,
    unattributed,
    baseFees,
    clients,
    totals: {
      meteredUsd: round2(meteredUsd),
      baseFeeUsd: round2(baseFeeUsd),
      unassignedUsd: round2(unassignedUsd),
      unattributedUsd: round2(unattributedUsd),
      costUsd: round2(costUsd),
      allocatedBaseFeeUsd: round2(allocatedBaseFeeUsd),
      absorbedBaseFeeUsd: round2(absorbedBaseFeeUsd),
      billableUsd,
      billableLocal: rate === null ? null : round2(billableUsd * rate),
      // What you keep: what you invoice, minus everything you paid.
      marginUsd: round2(billableUsd - costUsd),
      alreadyBilledZar: sumAlreadyBilled(projects),
      // Shared base fees belong to a client, not to any end customer, so the
      // customer view is smaller than the client view by exactly this much.
      sharedNotInCustomerView: round2(baseFeeUsd),
    },
  };
}

