import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  COLUMNS,
  STAGE_LABELS,
  filterByAssignment,
  filterProjects,
  parseAssignmentFilter,
  sortProjects,
  type SortDirection,
} from "@/lib/grid-view";

// exceljs is a Node library, and running the export here rather than in the
// browser keeps roughly a megabyte of spreadsheet machinery out of the client
// bundle for a button most sessions never press.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q") ?? "";
  const sort = params.get("sort");
  const direction: SortDirection = params.get("dir") === "asc" ? "asc" : "desc";
  const assignment = parseAssignmentFilter(params.get("assignment"));
  // The grid hides removed projects unless asked; the file follows suit.
  const includeHidden = params.get("hidden") === "1";

  const projects = await prisma.project.findMany({
    where: includeHidden ? undefined : { hidden: false },
    orderBy: [{ gitPushedAt: { sort: "desc", nulls: "last" } }, { name: "asc" }],
    include: {
      client: { select: { name: true } },
      endCustomer: { select: { name: true } },
      databases: { select: { provider: true, name: true } },
      domains: { select: { domain: true, isVercelDomain: true } },
      connections: { select: { label: true } },
    },
  });

  // Same filters and sort the grid applied, so the file matches the screen.
  const rows = sortProjects(
    filterByAssignment(filterProjects(projects, query), assignment),
    sort,
    direction,
  );

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "AI Project CRM";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Projects", {
    views: [{ state: "frozen", ySplit: 1 }], // header stays put, as on screen
  });

  // The visible grid columns, then the detail that only appears when a row is
  // expanded — in a spreadsheet there is no reason to hide it.
  sheet.columns = [
    ...COLUMNS.map((c) => ({
      header: c.label,
      key: c.key,
      width: c.type === "boolean" ? 10 : c.type === "number" ? 9 : 24,
    })),
    { header: "Production URL", key: "url", width: 42 },
    { header: "Vercel scope", key: "scope", width: 26 },
    { header: "Databases", key: "dbList", width: 30 },
    { header: "Custom domains", key: "domainList", width: 36 },
    { header: "External systems", key: "connList", width: 28 },
  ];

  for (const p of rows) {
    const record: Record<string, string | number | Date | null> = {};

    for (const column of COLUMNS) {
      const value = column.value(p);
      record[column.key] =
        column.type === "boolean"
          ? value
            ? "Yes"
            : "No"
          : column.type === "stage"
            ? (STAGE_LABELS[String(value)] ?? String(value))
            : (value as string | number | Date | null);
    }

    record.url = p.productionUrl ? `https://${p.productionUrl}` : null;
    record.scope = p.vercelScopeName;
    record.dbList = p.databases.map((d) => d.provider ?? d.name).join(", ") || null;
    record.domainList =
      p.domains
        .filter((d) => !d.isVercelDomain)
        .map((d) => d.domain)
        .join(", ") || null;
    record.connList = p.connections.map((c) => c.label).join(", ") || null;

    sheet.addRow(record);
  }

  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: "A1", to: { row: 1, column: sheet.columns.length } };

  const deployedColumn = sheet.getColumn("deployed");
  deployedColumn.numFmt = "dd mmm yyyy";

  const buffer = await workbook.xlsx.writeBuffer();
  const stamp = new Date().toISOString().slice(0, 10);

  return new NextResponse(buffer as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="ai-projects-${stamp}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
