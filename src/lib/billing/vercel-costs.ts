/**
 * Vercel cost collector — the only vendor that attributes spend to a project
 * with no help from us.
 *
 * `GET /v1/billing/charges` returns FOCUS v1.3 rows as JSONL, one per day per
 * service, and each row's `Tags` object carries the Vercel project id. Since
 * the inventory sync already stores `vercelProjectId` on every project, that is
 * a direct join — no mapping to maintain and nothing to keep in sync.
 *
 * Two things worth knowing before reading a Vercel number on the billing page:
 *
 *  * We bill on `BilledCost`, not `EffectiveCost`. BilledCost is what actually
 *    appears on the invoice, so the month's lines add up to the amount Vercel
 *    charged. EffectiveCost (amortised, discounts spread out) is kept in `raw`
 *    for when a figure needs explaining.
 *  * On a plan with an included allowance, usage inside the allowance has a
 *    BilledCost of zero and the money sits in a single Purchase row instead.
 *    That is not a bug and not missing data: those zero-cost rows still carry
 *    real quantities, which is what tells you who is consuming the plan, while
 *    the Purchase row becomes a base fee for you to split by client.
 */

import { VercelClient } from "@/lib/vercel";
import { CollectorUnavailable, type CollectResult, type CollectedLine, type PeriodWindow } from "./types";

/** The subset of FOCUS v1.3 we read. Everything else rides along in `raw`. */
interface FocusRow {
  BilledCost?: number;
  EffectiveCost?: number;
  BillingCurrency?: string;
  ChargeCategory?: string;
  ChargePeriodStart?: string;
  ChargePeriodEnd?: string;
  ConsumedQuantity?: number | null;
  ConsumedUnit?: string | null;
  PricingQuantity?: number;
  PricingUnit?: string;
  ServiceName?: string;
  ServiceCategory?: string;
  RegionId?: string;
  Tags?: Record<string, string>;
}

/**
 * Vercel documents that Tags carries "the Vercel ProjectId and ProjectName
 * information" without pinning the key casing, and FOCUS leaves tag keys to the
 * provider. Checking the plausible spellings costs nothing and means a casing
 * change upstream degrades to "unattributed" rather than silently zeroing every
 * project's Vercel cost.
 */
const PROJECT_ID_KEYS = ["ProjectId", "projectId", "project_id", "ProjectID", "vercel_project_id"];
const PROJECT_NAME_KEYS = ["ProjectName", "projectName", "project_name", "vercel_project_name"];

function pickTag(tags: Record<string, string> | undefined, keys: string[]): string | null {
  if (!tags) return null;
  for (const key of keys) {
    const value = tags[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * FOCUS charge categories, mapped onto our two kinds.
 *
 * A Purchase, Tax, Credit or Adjustment is caused by the business, so it lands
 * in the shared bucket to be split across clients by hand.
 *
 * ⚠️ The category alone is not enough, and assuming it was cost real money.
 * Vercel reports the **Pro seat subscription as ChargeCategory "Usage" with an
 * empty Tags object** — not as a Purchase, as this code originally assumed. That
 * left $19.86 of seat fees classed as metered usage belonging to no project,
 * sitting in "Unidentified" where no client bill could ever reach it. Together
 * with untagged Blob and transfer rows it was 57% of the month.
 *
 * So the real test is whether Vercel told us which project caused the row. A
 * Usage row carrying no project identity at all is not caused by a project,
 * whatever it is called, and belongs in the shared bucket.
 *
 * A row that DOES carry an identity we cannot match stays metered on purpose:
 * that is a mapping problem to be shown loudly, not a cost to quietly socialise
 * across every client.
 */
function kindFor(category: string | undefined, hasProjectIdentity: boolean) {
  if (category !== "Usage") return "BASE_FEE" as const;
  return hasProjectIdentity ? ("METERED" as const) : ("BASE_FEE" as const);
}

export async function collectVercel(window: PeriodWindow): Promise<CollectResult> {
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    throw new CollectorUnavailable("VERCEL", "VERCEL_TOKEN is not set");
  }

  const client = new VercelClient(token);
  const log: string[] = [];
  const lines: CollectedLine[] = [];

  // Billing is per team, and Carl's personal scope IS a team — so sweeping the
  // team list is both necessary and sufficient. Deduped by id in case the same
  // team is returned twice.
  const teams = await client.teams();
  const seen = new Set<string>();

  if (teams.length === 0) {
    log.push("Token can see no Vercel teams — nothing to bill.");
  }

  for (const team of teams) {
    if (!team.id || seen.has(team.id)) continue;
    seen.add(team.id);

    let jsonl: string;
    try {
      jsonl = await client.billingChargesJsonl(window.start, window.end, team.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // One scope failing must not lose the other. A 403 here almost always
      // means the token lacks a billing role on that specific team.
      log.push(`${team.slug}: ${message}`);
      continue;
    }

    const rows = parseJsonl(jsonl);
    let scopeCost = 0;
    let attributed = 0;
    let sharedCost = 0;

    for (const row of rows) {
      const cost = numberOr(row.BilledCost, 0);
      const category = row.ChargeCategory;
      const projectId = pickTag(row.Tags, PROJECT_ID_KEYS);
      const projectName = pickTag(row.Tags, PROJECT_NAME_KEYS);
      const kind = kindFor(category, Boolean(projectId || projectName));

      const chargedOn = row.ChargePeriodStart
        ? new Date(row.ChargePeriodStart)
        : window.start;
      if (Number.isNaN(chargedOn.getTime())) continue;

      // A row with no cost AND no quantity carries no information at all.
      const quantity = numberOrNull(row.ConsumedQuantity ?? row.PricingQuantity);
      if (cost === 0 && (quantity === null || quantity === 0)) continue;

      if (kind === "METERED" && projectId) attributed++;
      if (kind === "BASE_FEE") sharedCost += cost;
      scopeCost += cost;

      lines.push({
        vendor: "VERCEL",
        kind,
        projectKey:
          kind === "METERED" && projectId
            ? { by: "vercelProjectId", value: projectId, label: projectName ?? projectId }
            : null,
        service: row.ServiceName?.trim() || category || "Vercel",
        quantity,
        unit: row.ConsumedUnit ?? row.PricingUnit ?? null,
        costUsd: cost,
        source: "vercel:focus",
        // FOCUS rows have no id of their own, so the natural key is the day,
        // service and project — which is exactly the grain Vercel reports at.
        externalRef: [
          team.slug,
          chargedOn.toISOString().slice(0, 10),
          row.ServiceName ?? category ?? "?",
          projectId ?? "shared",
          row.RegionId ?? "",
        ].join("|"),
        raw: {
          scope: team.slug,
          chargeCategory: category,
          billedCost: row.BilledCost,
          effectiveCost: row.EffectiveCost,
          currency: row.BillingCurrency,
          serviceCategory: row.ServiceCategory,
          region: row.RegionId,
          projectName,
          tags: row.Tags,
        },
        chargedOn,
      });
    }

    log.push(
      `${team.slug}: ${rows.length} charge rows, ${attributed} tied to a project, ` +
        `$${sharedCost.toFixed(2)} of $${scopeCost.toFixed(2)} shared (untagged by Vercel).`,
    );
  }

  if (lines.length === 0 && seen.size > 0) {
    log.push(
      "No charge rows returned. Either the month has no spend yet, or the token lacks a billing role (Owner, Member, Developer, Security, Billing or Enterprise Viewer) on these teams.",
    );
  }

  return { lines, log };
}

function parseJsonl(text: string): FocusRow[] {
  const rows: FocusRow[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed) as FocusRow);
    } catch {
      // A single malformed line is not worth losing the month over, but it must
      // not pass silently either — a truncated stream would otherwise read as a
      // cheaper month rather than an incomplete one.
      rows.push({ ServiceName: "UNPARSEABLE ROW", ChargeCategory: "Adjustment", BilledCost: 0 });
    }
  }
  return rows;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
