/**
 * The cost ingest orchestrator.
 *
 * Runs each vendor's collector for one billing period, resolves the identities
 * they hand back against our own tables, and replaces that vendor's slice of
 * the month.
 *
 * Three rules it enforces:
 *
 *  1. **Replace, never append.** The open month is re-collected daily and
 *     vendors restate figures as a month settles, so each run deletes that
 *     vendor's rows for the period and writes the fresh set inside one
 *     transaction. Appending would multiply every number by the number of runs.
 *  2. **Never touch a hand-entered line.** Rows with source `manual` are Carl's
 *     and no collector may remove them.
 *  3. **Never silently drop a cost.** A metered line whose identity we cannot
 *     resolve is still written, with the identity preserved on the row, so the
 *     month's total stays honest and the gap is visible and fixable.
 *
 * Every attempt writes a CostIngestRun, including the ones that find nothing —
 * a collector that returned zero and a collector that was never called look
 * identical on a dashboard, and only one of those is fine.
 */

import { prisma } from "@/lib/db";
import type { Vendor } from "@/generated/prisma/enums";
import { collectVercel } from "./vercel-costs";
import { collectGitHub } from "./github-costs";
import { collectAnthropic } from "./anthropic-costs";
import { collectResend } from "./resend-costs";
import { periodLabel, periodWindow, fxRateDate, isoDate } from "./period";
import { fetchUsdToZar } from "./fx";
import {
  CollectorUnavailable,
  type CollectResult,
  type CollectedLine,
  type ProjectKey,
} from "./types";

/** Vendors with a collector. GOOGLE and OTHER are hand-entered. */
export const AUTOMATED_VENDORS: Vendor[] = ["VERCEL", "GITHUB", "ANTHROPIC", "RESEND"];

export interface VendorOutcome {
  vendor: Vendor;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  linesWritten: number;
  costUsd: number;
  unmapped: number;
  log: string[];
  error?: string;
}

export interface IngestResult {
  periodLabel: string;
  vendors: VendorOutcome[];
  fx: { rate: number | null; note: string };
}

/** Finds or creates the period row. Idempotent. */
export async function ensurePeriod(year: number, month: number) {
  const label = periodLabel(year, month);
  return prisma.billingPeriod.upsert({
    where: { year_month: { year, month } },
    update: {},
    create: { year, month, label },
  });
}

export async function getSettings() {
  return prisma.billingSettings.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
}

/**
 * Turns the identity a collector reported into one of our project ids.
 *
 * Built once per run from three lookups so that resolving thousands of lines
 * costs no extra queries.
 */
class ProjectResolver {
  private byVercel = new Map<string, string>();
  private byRepo = new Map<string, string>();
  /** repo name alone — only consulted when it is unambiguous across owners. */
  private byRepoName = new Map<string, string | null>();
  private byLink = new Map<string, string>();

  static async build(): Promise<ProjectResolver> {
    const resolver = new ProjectResolver();

    const [projects, links] = await Promise.all([
      prisma.project.findMany({
        select: { id: true, vercelProjectId: true, gitOwner: true, gitRepo: true },
      }),
      prisma.vendorProjectLink.findMany({
        select: { vendor: true, externalId: true, projectId: true },
      }),
    ]);

    for (const project of projects) {
      if (project.vercelProjectId) {
        resolver.byVercel.set(project.vercelProjectId, project.id);
      }
      if (project.gitRepo) {
        const repo = project.gitRepo.toLowerCase();
        if (project.gitOwner) {
          resolver.byRepo.set(`${project.gitOwner.toLowerCase()}/${repo}`, project.id);
        }
        // Null marks "seen more than once", which makes the fallback refuse
        // rather than pick the wrong project.
        resolver.byRepoName.set(
          repo,
          resolver.byRepoName.has(repo) ? null : project.id,
        );
      }
    }

    for (const link of links) {
      resolver.byLink.set(`${link.vendor}|${link.externalId}`, link.projectId);
    }

    return resolver;
  }

  resolve(key: ProjectKey): string | null {
    switch (key.by) {
      case "vercelProjectId":
        return this.byVercel.get(key.value) ?? null;
      case "gitRepo": {
        const repo = key.repo.toLowerCase();
        if (key.owner) {
          const hit = this.byRepo.get(`${key.owner.toLowerCase()}/${repo}`);
          if (hit) return hit;
        }
        return this.byRepoName.get(repo) ?? null;
      }
      case "vendorLink":
        return this.byLink.get(`${key.vendor}|${key.externalId}`) ?? null;
    }
  }
}

/** Stable identity for the mapping UI when resolution fails. */
function unresolvedIdentity(key: ProjectKey): { key: string; label: string } {
  switch (key.by) {
    case "vercelProjectId":
      return { key: key.value, label: key.label ?? key.value };
    case "gitRepo":
      return {
        key: key.owner ? `${key.owner}/${key.repo}` : key.repo,
        label: key.label ?? key.repo,
      };
    case "vendorLink":
      return { key: key.externalId, label: key.label ?? key.externalId };
  }
}

/**
 * The grain at which a vendor reports. Lines sharing a key are the same charge
 * and get summed — which also makes the ingest safe to run twice in a row.
 */
function dedupeKeyFor(line: CollectedLine, projectId: string | null): string {
  return [
    line.source,
    line.externalRef ?? "",
    line.service,
    line.unit ?? "",
    projectId ?? "",
    line.chargedOn.toISOString().slice(0, 10),
  ].join("#");
}

/** Runs one vendor and replaces its slice of the period. */
async function ingestVendor(
  vendor: Vendor,
  periodId: string,
  collect: () => Promise<CollectResult>,
  resolver: ProjectResolver,
): Promise<VendorOutcome> {
  const run = await prisma.costIngestRun.create({
    data: { periodId, vendor, status: "RUNNING" },
  });

  try {
    const { lines, log } = await collect();

    // Fold to the vendor's reporting grain before writing. Two lines with the
    // same key are the same charge reported twice, not two charges.
    const folded = new Map<
      string,
      {
        line: CollectedLine;
        projectId: string | null;
        unresolvedKey: string | null;
        unresolvedLabel: string | null;
        costUsd: number;
        quantity: number | null;
      }
    >();
    let unmapped = 0;

    for (const line of lines) {
      let projectId: string | null = null;
      let unresolvedKey: string | null = null;
      let unresolvedLabel: string | null = null;

      if (line.projectKey) {
        projectId = resolver.resolve(line.projectKey);
        if (!projectId) {
          const identity = unresolvedIdentity(line.projectKey);
          unresolvedKey = identity.key;
          unresolvedLabel = identity.label;
          unmapped++;
        }
      }

      const key = dedupeKeyFor(line, projectId);
      const existing = folded.get(key);

      if (existing) {
        existing.costUsd += line.costUsd;
        if (line.quantity !== null) {
          existing.quantity = (existing.quantity ?? 0) + line.quantity;
        }
      } else {
        folded.set(key, {
          line,
          projectId,
          unresolvedKey,
          unresolvedLabel,
          costUsd: line.costUsd,
          quantity: line.quantity,
        });
      }
    }

    const rows = [...folded.entries()].map(([dedupeKey, entry]) => ({
      periodId,
      vendor,
      vendorLabel: entry.line.vendorLabel ?? null,
      kind: entry.line.kind,
      projectId: entry.projectId,
      unresolvedKey: entry.unresolvedKey,
      unresolvedLabel: entry.unresolvedLabel,
      service: entry.line.service.slice(0, 300),
      quantity: entry.quantity,
      unit: entry.line.unit,
      costUsd: entry.costUsd,
      source: entry.line.source,
      externalRef: entry.line.externalRef ?? null,
      raw: (entry.line.raw ?? null) as never,
      chargedOn: entry.line.chargedOn,
      dedupeKey,
    }));

    const costUsd = rows.reduce((sum, row) => sum + row.costUsd, 0);

    // Replace this vendor's slice atomically. `source: manual` is excluded so a
    // hand-entered correction is never wiped by a collector.
    await prisma.$transaction([
      prisma.costLine.deleteMany({
        where: { periodId, vendor, source: { not: "manual" } },
      }),
      prisma.costLine.createMany({ data: rows }),
    ]);

    await prisma.costIngestRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        finishedAt: new Date(),
        linesWritten: rows.length,
        costUsdTotal: costUsd,
        unmapped,
        log: log.join("\n"),
      },
    });

    return { vendor, status: "SUCCESS", linesWritten: rows.length, costUsd, unmapped, log };
  } catch (err) {
    const skipped = err instanceof CollectorUnavailable;
    const error = err instanceof Error ? err.message : String(err);

    await prisma.costIngestRun.update({
      where: { id: run.id },
      data: {
        // "Not configured" is a different fact from "tried and broke", and the
        // billing page needs to tell them apart to say anything useful.
        status: skipped ? "PARTIAL" : "FAILED",
        finishedAt: new Date(),
        error,
      },
    });

    return {
      vendor,
      status: skipped ? "SKIPPED" : "FAILED",
      linesWritten: 0,
      costUsd: 0,
      unmapped: 0,
      log: [],
      error,
    };
  }
}

export interface IngestOptions {
  year: number;
  month: number;
  vendors?: Vendor[];
  /** Look up the FX rate if the period doesn't have one. Never overwrites. */
  fetchFx?: boolean;
}

export async function runCostIngest(options: IngestOptions): Promise<IngestResult> {
  const { year, month } = options;
  const period = await ensurePeriod(year, month);

  if (period.closed) {
    throw new Error(
      `${period.label} is closed. Re-open it before re-ingesting — closed periods back invoices that have already gone out.`,
    );
  }

  const [settings, resolver] = await Promise.all([getSettings(), ProjectResolver.build()]);
  const window = periodWindow(year, month);
  const wanted = new Set(options.vendors ?? AUTOMATED_VENDORS);
  const outcomes: VendorOutcome[] = [];

  // Sequential on purpose: four vendors, each rate-limited in its own way, and
  // a readable per-vendor log matters more here than a few seconds of latency.
  for (const vendor of AUTOMATED_VENDORS) {
    if (!wanted.has(vendor)) continue;

    const collect = () => {
      switch (vendor) {
        case "VERCEL":
          return collectVercel(window);
        case "GITHUB":
          return collectGitHub(window, year, month);
        case "ANTHROPIC":
          return collectAnthropic(window);
        case "RESEND":
          return collectResend(window, Number(settings.resendUsdPerEmail));
        default:
          throw new Error(`No collector for ${vendor}`);
      }
    };

    outcomes.push(await ingestVendor(vendor, period.id, collect, resolver));
  }

  // ------------------------------------------------------------------- FX
  let fxNote = period.usdToZar
    ? `Already set: 1 USD = ${Number(period.usdToZar).toFixed(4)} ${settings.billingCurrency}`
    : "No rate set — enter one to see rand figures.";

  if (options.fetchFx !== false && !period.usdToZar) {
    try {
      const lookup = await fetchUsdToZar(
        isoDate(fxRateDate(year, month)),
        settings.billingCurrency,
      );
      await prisma.billingPeriod.update({
        where: { id: period.id },
        data: {
          usdToZar: lookup.rate,
          rateSource: lookup.source,
          rateSetAt: new Date(),
        },
      });
      fxNote = `1 USD = ${lookup.rate.toFixed(4)} ${settings.billingCurrency} (${lookup.source}, ${lookup.effectiveOn})`;
    } catch (err) {
      fxNote = `Rate lookup failed — enter it by hand. ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const fresh = await prisma.billingPeriod.findUnique({ where: { id: period.id } });

  return {
    periodLabel: period.label,
    vendors: outcomes,
    fx: { rate: fresh?.usdToZar ? Number(fresh.usdToZar) : null, note: fxNote },
  };
}
