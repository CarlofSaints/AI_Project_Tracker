import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { buildPeriodRollup } from "@/lib/billing/rollup";
import { currentPeriod, parsePeriodLabel } from "@/lib/billing/period";

// exceljs is a Node library and roughly a megabyte — same reasoning as the
// project export: it stays on the server.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The billing workbook, built from the same rollup the page renders — so a
 * figure sent to a client and a figure on screen can never disagree.
 *
 * Four sheets, in the order someone actually uses them: what to invoice, what
 * it was made of, what was shared, and the raw lines behind all of it.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = (params.get("period") && parsePeriodLabel(params.get("period")!)) || currentPeriod();

  const period = await prisma.billingPeriod.findUnique({
    where: { year_month: { year: parsed.year, month: parsed.month } },
  });
  if (!period) {
    return NextResponse.json({ error: "That period has no data yet" }, { status: 404 });
  }

  const rollup = await buildPeriodRollup(period.id);
  if (!rollup) {
    return NextResponse.json({ error: "Could not build the rollup" }, { status: 500 });
  }

  const rate = rollup.period.usdToZar;
  const currency = rollup.currency;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Project CRM";
  workbook.created = new Date();

  // ------------------------------------------------------------- invoices
  const invoices = workbook.addWorksheet("Client bills", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  invoices.columns = [
    { header: "Client", key: "client", width: 30 },
    // Who the work was for. A client invoice covering three end customers is
    // unreadable without this, and it's the first thing they'll ask about.
    { header: "End customers", key: "customers", width: 34 },
    { header: "Projects", key: "projects", width: 10 },
    { header: "Direct cost (USD)", key: "direct", width: 18 },
    { header: "Share of shared (USD)", key: "shared", width: 20 },
    { header: "Total cost (USD)", key: "cost", width: 18 },
    { header: "Markup %", key: "markup", width: 11 },
    { header: "Markup (USD)", key: "markupUsd", width: 15 },
    { header: "Billable (USD)", key: "billable", width: 16 },
    { header: `Billable (${currency})`, key: "billableLocal", width: 18 },
    // Reference only, never netted off. It sits here so nobody splits a shared
    // cost onto a client who is already paying a retainer that covers it.
    { header: "Already billed monthly (ZAR)", key: "alreadyBilled", width: 26 },
  ];
  for (const client of rollup.clients) {
    invoices.addRow({
      client: client.name,
      customers:
        [
          ...new Set(
            client.projects
              .map((p) => p.endCustomerName)
              .filter((name): name is string => Boolean(name)),
          ),
        ].join(", ") || null,
      projects: client.projects.length,
      direct: client.directCostUsd,
      shared: client.sharedCostUsd,
      cost: client.costUsd,
      markup: client.markupBasisPoints / 100,
      markupUsd: client.markupUsd,
      billable: client.billableUsd,
      billableLocal: client.billableLocal,
      alreadyBilled: client.alreadyBilledZar,
    });
  }
  // The total row sums the client columns above it and nothing else. Putting a
  // business-wide figure (total cost, margin) into the same column as a
  // per-client one would mean the column held two different quantities — so
  // those get their own labelled rows underneath instead.
  invoices.addRow({});
  invoices.addRow({
    client: "TOTAL BILLED",
    projects: rollup.clients.reduce((sum, c) => sum + c.projects.length, 0),
    direct: money(rollup.clients.reduce((sum, c) => sum + c.directCostUsd, 0)),
    shared: money(rollup.clients.reduce((sum, c) => sum + c.sharedCostUsd, 0)),
    cost: money(rollup.clients.reduce((sum, c) => sum + c.costUsd, 0)),
    markupUsd: money(rollup.clients.reduce((sum, c) => sum + c.markupUsd, 0)),
    billable: rollup.totals.billableUsd,
    billableLocal: rollup.totals.billableLocal,
    alreadyBilled: rollup.totals.alreadyBilledZar,
  }).font = { bold: true };

  invoices.addRow({});
  for (const [label, value] of [
    ["Third-party cost for the month", rollup.totals.costUsd],
    ["  of which metered to a project", rollup.totals.meteredUsd],
    ["  of which subscriptions and seats", rollup.totals.baseFeeUsd],
    ["Cost on projects with no client", rollup.totals.unassignedUsd],
    ["Cost that could not be attributed", rollup.totals.unattributedUsd],
    ["Shared cost absorbed by the business", rollup.totals.absorbedBaseFeeUsd],
    ["Margin (billed minus all cost)", rollup.totals.marginUsd],
  ] as const) {
    invoices.addRow({ client: label, billable: value });
  }

  // ------------------------------------------------------------- customers
  // The same month grouped by who the work was for rather than who pays. Marked
  // up at each paying client's own rate, so a customer served through two
  // clients on different terms still adds up to what will actually be invoiced.
  const byCustomer = workbook.addWorksheet("By customer", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  byCustomer.columns = [
    { header: "End customer", key: "customer", width: 30 },
    // A blank end-customer field means the client is the end customer. That is
    // a real answer, but it is derived, so it is labelled rather than passed off
    // as recorded fact.
    { header: "End customer recorded on", key: "recorded", width: 26 },
    { header: "Billed through (client)", key: "clients", width: 30 },
    { header: "Projects", key: "projects", width: 10 },
    { header: "Direct cost (USD)", key: "cost", width: 18 },
    { header: "Markup (USD)", key: "markupUsd", width: 15 },
    { header: "Billable (USD)", key: "billable", width: 16 },
    { header: `Billable (${currency})`, key: "billableLocal", width: 18 },
    { header: "Already billed monthly (ZAR)", key: "alreadyBilled", width: 26 },
  ];
  for (const customer of rollup.customers) {
    byCustomer.addRow({
      customer: customer.name,
      recorded: recordedLabel(customer.projects.length, customer.impliedProjectCount),
      clients: customer.clientNames.join(", "),
      projects: customer.projects.length,
      cost: customer.costUsd,
      markupUsd: customer.markupUsd,
      billable: customer.billableUsd,
      billableLocal: customer.billableLocal,
      alreadyBilled: customer.alreadyBilledZar,
    });
  }

  byCustomer.addRow({});
  byCustomer.addRow({
    customer: "TOTAL, DIRECT COST ONLY",
    projects: rollup.customers.reduce((sum, c) => sum + c.projects.length, 0),
    cost: money(rollup.customers.reduce((sum, c) => sum + c.costUsd, 0)),
    markupUsd: money(rollup.customers.reduce((sum, c) => sum + c.markupUsd, 0)),
    billable: money(rollup.customers.reduce((sum, c) => sum + c.billableUsd, 0)),
    billableLocal:
      rate === null
        ? null
        : money(rollup.customers.reduce((sum, c) => sum + c.billableUsd, 0) * rate),
    alreadyBilled: rollup.totals.alreadyBilledZar,
  }).font = { bold: true };

  // Why this sheet is smaller than Client bills. Saying it here beats someone
  // finding the gap on their own and assuming a number went missing.
  byCustomer.addRow({});
  byCustomer.addRow({
    customer: "Shared costs are not in this sheet",
    billable: rollup.totals.sharedNotInCustomerView,
  });
  byCustomer.addRow({
    customer:
      "Subscriptions and seats are allocated to a client, not to an end customer, so they only appear on Client bills and Shared costs.",
  });

  // -------------------------------------------------------------- projects
  const byProject = workbook.addWorksheet("By project", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  byProject.columns = [
    { header: "Project", key: "project", width: 34 },
    { header: "Client (you invoice)", key: "client", width: 26 },
    { header: "End customer (work is for)", key: "customer", width: 26 },
    { header: "Vendor", key: "vendor", width: 14 },
    { header: "Service", key: "service", width: 44 },
    { header: "Quantity", key: "quantity", width: 16 },
    { header: "Unit", key: "unit", width: 14 },
    { header: "Cost (USD)", key: "cost", width: 14 },
    { header: `Cost (${currency})`, key: "costLocal", width: 16 },
    { header: "Already billed monthly (ZAR)", key: "alreadyBilled", width: 26 },
  ];
  for (const project of [...rollup.projects, ...rollup.unassigned]) {
    let first = true;
    for (const service of project.services) {
      byProject.addRow({
        project: project.name,
        client: project.clientName ?? "— no client —",
        customer: project.endCustomerName ?? "",
        // Only on the project's first row: repeating a monthly retainer against
        // every service line would make any column total wildly wrong.
        alreadyBilled: first ? project.alreadyBilledZar : null,
        vendor: service.vendorLabel,
        service: service.service,
        quantity: service.quantity,
        unit: service.unit,
        cost: service.costUsd,
        costLocal: rate === null ? null : service.costUsd * rate,
      });
      first = false;
    }
  }

  // ----------------------------------------------------------- shared costs
  const shared = workbook.addWorksheet("Shared costs", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  shared.columns = [
    { header: "Vendor", key: "vendor", width: 16 },
    { header: "Base fee (USD)", key: "total", width: 16 },
    { header: "Client", key: "client", width: 30 },
    { header: "Share %", key: "share", width: 11 },
    { header: "Amount (USD)", key: "amount", width: 16 },
    { header: "Note", key: "note", width: 40 },
  ];
  for (const fee of rollup.baseFees) {
    for (const allocation of fee.allocations) {
      shared.addRow({
        vendor: fee.vendorLabel,
        total: fee.costUsd,
        client: allocation.clientName,
        share: allocation.shareBasisPoints / 100,
        amount: allocation.amountUsd,
        note: allocation.note,
      });
    }
    if (fee.absorbedUsd > 0.005) {
      shared.addRow({
        vendor: fee.vendorLabel,
        total: fee.costUsd,
        client: "— absorbed by OuterJoin —",
        share: (10000 - fee.allocatedBasisPoints) / 100,
        amount: fee.absorbedUsd,
        note: "Not allocated to any client",
      });
    }
  }

  // ------------------------------------------------------------- raw lines
  const lines = await prisma.costLine.findMany({
    where: { periodId: period.id },
    include: { project: { select: { name: true } } },
    orderBy: [{ vendor: "asc" }, { chargedOn: "asc" }],
  });

  const raw = workbook.addWorksheet("Raw lines", { views: [{ state: "frozen", ySplit: 1 }] });
  raw.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Vendor", key: "vendor", width: 14 },
    { header: "Kind", key: "kind", width: 11 },
    { header: "Project", key: "project", width: 30 },
    { header: "Service", key: "service", width: 44 },
    { header: "Quantity", key: "quantity", width: 16 },
    { header: "Unit", key: "unit", width: 12 },
    { header: "Cost (USD)", key: "cost", width: 14 },
    { header: "Source", key: "source", width: 24 },
    { header: "Unmapped account", key: "unresolved", width: 30 },
  ];
  for (const line of lines) {
    raw.addRow({
      date: line.chargedOn,
      vendor: line.vendorLabel ?? line.vendor,
      kind: line.kind,
      project: line.project?.name ?? (line.kind === "BASE_FEE" ? "— shared —" : "— unattributed —"),
      service: line.service,
      quantity: line.quantity === null ? null : Number(line.quantity),
      unit: line.unit,
      cost: Number(line.costUsd),
      source: line.source,
      unresolved: line.unresolvedLabel ?? line.unresolvedKey,
    });
  }

  for (const sheet of [invoices, byProject, shared, raw]) {
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };
  }
  for (const key of ["direct", "shared", "cost", "markupUsd", "billable"]) {
    invoices.getColumn(key).numFmt = '"$"#,##0.00';
  }
  invoices.getColumn("billableLocal").numFmt = `"${currency} "#,##0.00`;
  invoices.getColumn("markup").numFmt = '0.00"%"';
  byProject.getColumn("cost").numFmt = '"$"#,##0.00';
  byProject.getColumn("costLocal").numFmt = `"${currency} "#,##0.00`;
  shared.getColumn("total").numFmt = '"$"#,##0.00';
  shared.getColumn("amount").numFmt = '"$"#,##0.00';
  shared.getColumn("share").numFmt = '0.00"%"';
  raw.getColumn("cost").numFmt = '"$"#,##0.00';
  raw.getColumn("date").numFmt = "dd mmm yyyy";

  const buffer = await workbook.xlsx.writeBuffer();

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="billing-${rollup.period.label}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}

/** A float sum lands in the cell verbatim, so round before it gets there. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How an end customer was arrived at. A blank end-customer field means the
 * client is the end customer, which is a real answer but a derived one, so it
 * is spelled out rather than passed off as recorded fact.
 */
function recordedLabel(total: number, implied: number): string {
  if (implied === 0) return "All projects";
  if (implied === total) return "None, assumed from the client";
  return `${total - implied} of ${total} projects, rest assumed from the client`;
}
