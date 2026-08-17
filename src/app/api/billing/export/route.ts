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
    { header: "Projects", key: "projects", width: 10 },
    { header: "Direct cost (USD)", key: "direct", width: 18 },
    { header: "Share of shared (USD)", key: "shared", width: 20 },
    { header: "Total cost (USD)", key: "cost", width: 18 },
    { header: "Markup %", key: "markup", width: 11 },
    { header: "Markup (USD)", key: "markupUsd", width: 15 },
    { header: "Billable (USD)", key: "billable", width: 16 },
    { header: `Billable (${currency})`, key: "billableLocal", width: 18 },
  ];
  for (const client of rollup.clients) {
    invoices.addRow({
      client: client.name,
      projects: client.projects.length,
      direct: client.directCostUsd,
      shared: client.sharedCostUsd,
      cost: client.costUsd,
      markup: client.markupBasisPoints / 100,
      markupUsd: client.markupUsd,
      billable: client.billableUsd,
      billableLocal: client.billableLocal,
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
    direct: rollup.clients.reduce((sum, c) => sum + c.directCostUsd, 0),
    shared: rollup.clients.reduce((sum, c) => sum + c.sharedCostUsd, 0),
    cost: rollup.clients.reduce((sum, c) => sum + c.costUsd, 0),
    markupUsd: rollup.clients.reduce((sum, c) => sum + c.markupUsd, 0),
    billable: rollup.totals.billableUsd,
    billableLocal: rollup.totals.billableLocal,
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

  // -------------------------------------------------------------- projects
  const byProject = workbook.addWorksheet("By project", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  byProject.columns = [
    { header: "Project", key: "project", width: 34 },
    { header: "Client", key: "client", width: 26 },
    { header: "Vendor", key: "vendor", width: 14 },
    { header: "Service", key: "service", width: 44 },
    { header: "Quantity", key: "quantity", width: 16 },
    { header: "Unit", key: "unit", width: 14 },
    { header: "Cost (USD)", key: "cost", width: 14 },
    { header: `Cost (${currency})`, key: "costLocal", width: 16 },
  ];
  for (const project of [...rollup.projects, ...rollup.unassigned]) {
    for (const service of project.services) {
      byProject.addRow({
        project: project.name,
        client: project.clientName ?? "— no client —",
        vendor: service.vendorLabel,
        service: service.service,
        quantity: service.quantity,
        unit: service.unit,
        cost: service.costUsd,
        costLocal: rate === null ? null : service.costUsd * rate,
      });
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
