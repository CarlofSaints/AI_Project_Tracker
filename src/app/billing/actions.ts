"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import type { CostKind, Vendor } from "@/generated/prisma/enums";
import { runCostIngest, ensurePeriod, getSettings } from "@/lib/billing/ingest";
import { buildPeriodRollup } from "@/lib/billing/rollup";
import { parsePeriodLabel, fxRateDate, isoDate } from "@/lib/billing/period";
import { fetchUsdToZar } from "@/lib/billing/fx";

function refresh(label: string) {
  revalidatePath("/billing");
  revalidatePath(`/billing?period=${label}`);
}

/** Guard every mutation: a closed period backs invoices that have gone out. */
async function assertOpen(periodId: string) {
  const period = await prisma.billingPeriod.findUnique({
    where: { id: periodId },
    select: { closed: true, label: true, year: true, month: true },
  });
  if (!period) throw new Error("Unknown billing period");
  if (period.closed) {
    throw new Error(`${period.label} is closed — re-open it before making changes.`);
  }
  return period;
}

export async function collectCosts(periodLabel: string, vendors?: Vendor[]) {
  const parsed = parsePeriodLabel(periodLabel);
  if (!parsed) return { ok: false as const, error: `"${periodLabel}" is not a YYYY-MM period` };

  try {
    const result = await runCostIngest({ ...parsed, vendors });
    refresh(periodLabel);
    return { ok: true as const, ...result };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Replaces one vendor's whole allocation set for a period.
 *
 * Sent as a set rather than row-by-row because the shares are only meaningful
 * together — a half-applied save would leave a split that doesn't add up, and
 * whichever screen read it next would quietly bill the wrong amount.
 */
export async function saveAllocations(
  periodId: string,
  vendor: Vendor,
  rows: Array<{ clientId: string; shareBasisPoints: number; note?: string | null }>,
) {
  try {
    const period = await assertOpen(periodId);

    const clean = rows
      .map((row) => ({
        clientId: row.clientId,
        shareBasisPoints: Math.max(0, Math.min(10000, Math.round(row.shareBasisPoints))),
        note: row.note?.trim() || null,
      }))
      .filter((row) => row.clientId && row.shareBasisPoints > 0);

    const total = clean.reduce((sum, row) => sum + row.shareBasisPoints, 0);
    if (total > 10000) {
      return {
        ok: false as const,
        error: `Shares add up to ${(total / 100).toFixed(2)}% — that's more than the fee.`,
      };
    }

    await prisma.$transaction([
      prisma.sharedCostAllocation.deleteMany({ where: { periodId, vendor } }),
      ...(clean.length
        ? [
            prisma.sharedCostAllocation.createMany({
              data: clean.map((row) => ({ periodId, vendor, ...row })),
            }),
          ]
        : []),
    ]);

    refresh(period.label);
    return { ok: true as const, allocatedBasisPoints: total };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ties a vendor's own identity (an Anthropic workspace, a Resend domain, a GCP
 * project) to one of ours — and repairs the cost lines already sitting in open
 * periods that were waiting on exactly this mapping.
 *
 * Repairing in place matters: without it, mapping a workspace would change
 * nothing visible until the next ingest, and the obvious conclusion would be
 * that the mapping didn't work.
 */
export async function mapVendorAccount(
  vendor: Vendor,
  externalId: string,
  externalLabel: string | null,
  projectId: string,
) {
  try {
    const id = externalId.trim();
    if (!id) return { ok: false as const, error: "No account id to map" };

    await prisma.vendorProjectLink.upsert({
      where: { vendor_externalId: { vendor, externalId: id } },
      update: { projectId, externalLabel },
      create: { vendor, externalId: id, externalLabel, projectId },
    });

    const repaired = await prisma.costLine.updateMany({
      where: {
        vendor,
        unresolvedKey: id,
        projectId: null,
        period: { closed: false },
      },
      data: { projectId, unresolvedKey: null, unresolvedLabel: null },
    });

    revalidatePath("/billing");
    return { ok: true as const, repaired: repaired.count };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function unmapVendorAccount(vendor: Vendor, externalId: string) {
  await prisma.vendorProjectLink.deleteMany({ where: { vendor, externalId } });
  revalidatePath("/billing");
  return { ok: true as const };
}

export async function setPeriodRate(periodId: string, rate: number) {
  try {
    const period = await assertOpen(periodId);
    if (!Number.isFinite(rate) || rate <= 0) {
      return { ok: false as const, error: "Rate must be a positive number" };
    }
    await prisma.billingPeriod.update({
      where: { id: periodId },
      data: { usdToZar: rate, rateSource: "manual", rateSetAt: new Date() },
    });
    refresh(period.label);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function refetchPeriodRate(periodId: string) {
  try {
    const period = await prisma.billingPeriod.findUniqueOrThrow({ where: { id: periodId } });
    if (period.closed) return { ok: false as const, error: `${period.label} is closed.` };

    const settings = await getSettings();
    const lookup = await fetchUsdToZar(
      isoDate(fxRateDate(period.year, period.month)),
      settings.billingCurrency,
    );

    await prisma.billingPeriod.update({
      where: { id: periodId },
      data: { usdToZar: lookup.rate, rateSource: lookup.source, rateSetAt: new Date() },
    });
    refresh(period.label);
    return { ok: true as const, rate: lookup.rate, effectiveOn: lookup.effectiveOn };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Freezes a period. The rate and the allocations are already stored, so the one
 * remaining live input is each client's markup — materialise it, and a rate
 * change tomorrow can no longer rewrite an invoice sent today.
 */
export async function closePeriod(periodId: string) {
  try {
    const period = await assertOpen(periodId);
    const rollup = await buildPeriodRollup(periodId);
    if (!rollup) return { ok: false as const, error: "Period not found" };

    if (rollup.period.usdToZar === null) {
      return {
        ok: false as const,
        error: "Set the exchange rate before closing — the rand figures would be frozen as blank.",
      };
    }

    await prisma.$transaction([
      prisma.clientPeriodTerms.deleteMany({ where: { periodId } }),
      prisma.clientPeriodTerms.createMany({
        data: rollup.clients.map((client) => ({
          periodId,
          clientId: client.clientId,
          markupBasisPoints: client.markupBasisPoints,
        })),
      }),
      prisma.billingPeriod.update({
        where: { id: periodId },
        data: { closed: true, closedAt: new Date() },
      }),
    ]);

    refresh(period.label);
    return { ok: true as const, clients: rollup.clients.length };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function reopenPeriod(periodId: string) {
  const period = await prisma.billingPeriod.update({
    where: { id: periodId },
    data: { closed: false, closedAt: null },
  });
  // The frozen markups stay. Re-opening is for correcting a figure, not for
  // silently re-pricing a client — delete the terms explicitly if that's wanted.
  refresh(period.label);
  return { ok: true as const };
}

export async function setClientMarkup(clientId: string, basisPoints: number | null) {
  await prisma.organization.update({
    where: { id: clientId },
    data: {
      markupBasisPoints:
        basisPoints === null ? null : Math.max(0, Math.min(100000, Math.round(basisPoints))),
    },
  });
  revalidatePath("/billing");
  revalidatePath("/organizations");
  return { ok: true as const };
}

export async function updateBillingSettings(patch: {
  defaultMarkupBasisPoints?: number;
  resendUsdPerEmail?: number;
  billingCurrency?: string;
}) {
  await prisma.billingSettings.upsert({
    where: { id: "singleton" },
    update: patch,
    create: { id: "singleton", ...patch },
  });
  revalidatePath("/billing");
  return { ok: true as const };
}

/**
 * A hand-entered cost. This is the whole answer for vendors with no usable API
 * — Google, and anything else that turns up on a card statement. Marked
 * `source: manual` so no collector will ever delete it.
 */
export async function addManualCostLine(input: {
  periodId: string;
  vendor: Vendor;
  vendorLabel?: string | null;
  kind: CostKind;
  projectId?: string | null;
  service: string;
  quantity?: number | null;
  unit?: string | null;
  costUsd: number;
}) {
  try {
    const period = await assertOpen(input.periodId);

    const service = input.service.trim();
    if (!service) return { ok: false as const, error: "Describe what the charge was for" };
    if (!Number.isFinite(input.costUsd)) {
      return { ok: false as const, error: "Cost must be a number" };
    }
    if (input.kind === "METERED" && !input.projectId) {
      return {
        ok: false as const,
        error: "A metered line needs a project. Use a base fee if it belongs to no single project.",
      };
    }

    await prisma.costLine.create({
      data: {
        periodId: input.periodId,
        vendor: input.vendor,
        vendorLabel: input.vendor === "OTHER" ? input.vendorLabel?.trim() || "Other" : null,
        kind: input.kind,
        projectId: input.kind === "METERED" ? input.projectId : null,
        service,
        quantity: input.quantity ?? null,
        unit: input.unit?.trim() || null,
        costUsd: input.costUsd,
        source: "manual",
        // Dated to the first of the period. A hand-entered charge belongs to
        // the month, not to a day — and dating it "today" would push a line
        // entered in September into an August period it doesn't sit in.
        chargedOn: new Date(Date.UTC(period.year, period.month - 1, 1)),
        // Hand-entered lines are intentionally never folded together: two
        // identical $40 Google charges in one month are two charges.
        dedupeKey: `manual#${service}#${Date.now()}#${Math.random().toString(36).slice(2, 8)}`,
      },
    });

    refresh(period.label);
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteCostLine(id: string) {
  const line = await prisma.costLine.findUnique({
    where: { id },
    select: { source: true, period: { select: { closed: true, label: true } } },
  });
  if (!line) return { ok: false as const, error: "Line not found" };
  if (line.period.closed) {
    return { ok: false as const, error: `${line.period.label} is closed.` };
  }
  if (line.source !== "manual") {
    return {
      ok: false as const,
      error: "Only hand-entered lines can be deleted — collected lines come back on the next run.",
    };
  }

  await prisma.costLine.delete({ where: { id } });
  refresh(line.period.label);
  return { ok: true as const };
}

/** Creates the period row so a month can be opened before it has any costs. */
export async function openPeriod(periodLabel: string) {
  const parsed = parsePeriodLabel(periodLabel);
  if (!parsed) return { ok: false as const, error: `"${periodLabel}" is not a YYYY-MM period` };
  await ensurePeriod(parsed.year, parsed.month);
  refresh(periodLabel);
  return { ok: true as const };
}
