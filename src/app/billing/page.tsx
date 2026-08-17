import { prisma } from "@/lib/db";
import { buildPeriodRollup, formatUsd, formatLocal } from "@/lib/billing/rollup";
import { ensurePeriod } from "@/lib/billing/ingest";
import { currentPeriod, parsePeriodLabel, periodDisplay } from "@/lib/billing/period";
import { StatCard } from "@/components/stat-card";
import { PeriodHeader } from "@/components/billing/period-header";
import { AttentionPanel } from "@/components/billing/attention-panel";
import { BaseFeeAllocator } from "@/components/billing/base-fee-allocator";
import { ClientBills } from "@/components/billing/client-bills";
import { ProjectCosts } from "@/components/billing/project-costs";
import { BillingControls } from "@/components/billing/billing-controls";

// Costs are read live from Postgres; the ingest job is the cache.
export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: requested } = await searchParams;
  const parsed = (requested && parsePeriodLabel(requested)) || currentPeriod();

  // Opening a month that has never been collected should show an empty billing
  // page, not a 404 — the row is created on first view.
  const period = await ensurePeriod(parsed.year, parsed.month);

  const [rollup, periods, organizations, projects, runs, links, manualLines] = await Promise.all([
    buildPeriodRollup(period.id),
    prisma.billingPeriod.findMany({
      orderBy: [{ year: "desc" }, { month: "desc" }],
      select: { label: true, closed: true },
      take: 36,
    }),
    prisma.organization.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, markupBasisPoints: true },
    }),
    prisma.project.findMany({
      where: { hidden: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, clientId: true },
    }),
    prisma.costIngestRun.findMany({
      where: { periodId: period.id },
      orderBy: { startedAt: "desc" },
      take: 24,
    }),
    prisma.vendorProjectLink.findMany({
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ vendor: "asc" }, { externalId: "asc" }],
    }),
    prisma.costLine.findMany({
      where: { periodId: period.id, source: "manual" },
      include: { project: { select: { name: true } } },
      orderBy: { ingestedAt: "desc" },
    }),
  ]);

  if (!rollup) {
    return <p className="text-sm text-neutral-500">Could not load {period.label}.</p>;
  }

  const { totals, currency } = rollup;

  // The freshest attempt per vendor is what matters — an older success does not
  // undo a newer failure.
  const latestByVendor = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!latestByVendor.has(run.vendor)) latestByVendor.set(run.vendor, run);
  const latestRuns = [...latestByVendor.values()];

  // Everything you paid for but are not charging anyone for.
  const unbilledUsd =
    totals.unassignedUsd + totals.unattributedUsd + totals.absorbedBaseFeeUsd;

  return (
    <div className="space-y-8">
      <PeriodHeader
        periodLabel={rollup.period.label}
        display={rollup.period.display}
        closed={rollup.period.closed}
        periodId={rollup.period.id}
        knownPeriods={periods}
        hasRate={rollup.period.usdToZar !== null}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Third-party cost"
          value={formatUsd(totals.costUsd)}
          hint={
            totals.billableLocal !== null && rollup.period.usdToZar
              ? `${formatLocal(totals.costUsd * rollup.period.usdToZar, currency)} at ${rollup.period.usdToZar.toFixed(4)}`
              : "No exchange rate set"
          }
          accent="gradient"
        />
        <StatCard
          label="Billable to clients"
          value={formatUsd(totals.billableUsd)}
          hint={
            totals.billableLocal === null
              ? "Cost plus markup"
              : formatLocal(totals.billableLocal, currency)
          }
          accent="brand"
        />
        <StatCard
          label="Margin"
          value={formatUsd(totals.marginUsd)}
          hint={
            totals.costUsd > 0
              ? `${((totals.marginUsd / totals.costUsd) * 100).toFixed(1)}% on cost`
              : "Nothing collected yet"
          }
          accent="brand2"
        />
        <StatCard
          label="Not billed to anyone"
          value={formatUsd(unbilledUsd)}
          hint={
            unbilledUsd > 0
              ? "Unassigned, unmapped or absorbed — see below"
              : "Every cost is attributed"
          }
          accent={unbilledUsd > 0 ? "warn" : "brand2"}
        />
      </div>

      <AttentionPanel
        rollup={rollup}
        projects={projects}
        runs={latestRuns.map((run) => ({
          vendor: run.vendor,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          linesWritten: run.linesWritten,
          costUsdTotal: Number(run.costUsdTotal),
          unmapped: run.unmapped,
          error: run.error,
          log: run.log,
        }))}
        links={links.map((link) => ({
          id: link.id,
          vendor: link.vendor,
          externalId: link.externalId,
          externalLabel: link.externalLabel,
          projectName: link.project.name,
        }))}
      />

      <BaseFeeAllocator rollup={rollup} organizations={organizations} />

      <ClientBills rollup={rollup} organizations={organizations} />

      <ProjectCosts rollup={rollup} />

      <BillingControls
        rollup={rollup}
        projects={projects}
        manualLines={manualLines.map((line) => ({
          id: line.id,
          vendor: line.vendor,
          vendorLabel: line.vendorLabel,
          kind: line.kind,
          service: line.service,
          projectName: line.project?.name ?? null,
          costUsd: Number(line.costUsd),
        }))}
        defaultMarkupBasisPoints={rollup.defaultMarkupBasisPoints}
        resendUsdPerEmail={await resendRate()}
      />
    </div>
  );
}

async function resendRate(): Promise<number> {
  const settings = await prisma.billingSettings.findUnique({ where: { id: "singleton" } });
  return settings ? Number(settings.resendUsdPerEmail) : 0;
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period } = await searchParams;
  const parsed = (period && parsePeriodLabel(period)) || currentPeriod();
  return { title: `Billing — ${periodDisplay(parsed.year, parsed.month)}` };
}
