/**
 * GitHub cost collector.
 *
 * The billing usage endpoint returns one line item per product per repo per
 * day, and `repositoryName` is the attribution key — the inventory already
 * stores gitOwner/gitRepo on every project, so Actions minutes and Packages
 * storage land on the right project with no mapping to maintain.
 *
 * Products that aren't repo-scoped (a Copilot seat, an org plan) arrive with no
 * repository and become base fees to split across clients by hand.
 *
 * Note the endpoint reports the *metered* side of the bill. A plan's included
 * allowance shows as netAmount 0 against a real quantity — same shape as Vercel,
 * and read the same way: the quantity is the signal, the plan fee is the money.
 */

import { GitHubClient, configuredOwners, type GitHubUsageItem } from "@/lib/github";
import { CollectorUnavailable, type CollectResult, type CollectedLine, type PeriodWindow } from "./types";

/** Products that can never belong to a single project. */
const ALWAYS_SHARED = new Set(["copilot", "github copilot", "enterprise", "seats"]);

export async function collectGitHub(
  window: PeriodWindow,
  year: number,
  month: number,
): Promise<CollectResult> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new CollectorUnavailable("GITHUB", "GITHUB_TOKEN is not set");
  }

  const owners = configuredOwners(process.env.GITHUB_OWNERS);
  if (owners.length === 0) {
    throw new CollectorUnavailable("GITHUB", "GITHUB_OWNERS is not set");
  }

  const client = new GitHubClient(token);
  const log: string[] = [];
  const lines: CollectedLine[] = [];

  for (const { owner, isOrg } of owners) {
    let items: GitHubUsageItem[];
    try {
      items = await client.billingUsage(owner, isOrg, year, month);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // GitHub answers a token without billing scope with **404**, not 403 —
      // it declines to confirm the endpoint exists. Verified against a live
      // token: /users/{me}/settings/billing/usage returns "Not Found" while the
      // org endpoint on the same token succeeds. Reporting that verbatim would
      // read as "no such account", so both codes get the real explanation.
      const denied = message.includes("404") || message.includes("403");
      log.push(
        denied
          ? `${owner}: no billing access (${message.includes("404") ? "404" : "403"}). ` +
              `The token needs billing read — fine-grained: "Plan" (read) on the ${isOrg ? "organisation" : "account"}; ` +
              `classic: manage_billing:${isOrg ? "org" : "user"}. Enhanced billing also requires the account to be on the new billing platform.`
          : `${owner}: ${message}`,
      );
      continue;
    }

    let ownerCost = 0;
    let attributed = 0;

    for (const item of items) {
      const cost = numberOr(item.netAmount ?? item.grossAmount, 0);
      const quantity = numberOrNull(item.quantity);
      if (cost === 0 && (quantity === null || quantity === 0)) continue;

      const product = (item.product ?? "").trim();
      const repoFull = (item.repositoryName ?? "").trim();
      const isShared = !repoFull || ALWAYS_SHARED.has(product.toLowerCase());

      // repositoryName arrives either bare ("AI_Project_Tracker") or fully
      // qualified ("CarlofSaints/AI_Project_Tracker") depending on the account
      // type, so normalise before matching.
      const [maybeOwner, maybeRepo] = repoFull.includes("/")
        ? repoFull.split("/", 2)
        : [item.organizationName?.trim() || owner, repoFull];

      const chargedOn = item.date ? new Date(item.date) : window.start;
      const day = Number.isNaN(chargedOn.getTime()) ? window.start : chargedOn;

      if (!isShared) attributed++;
      ownerCost += cost;

      lines.push({
        vendor: "GITHUB",
        kind: isShared ? "BASE_FEE" : "METERED",
        projectKey: isShared
          ? null
          : { by: "gitRepo", owner: maybeOwner || owner, repo: maybeRepo, label: repoFull },
        service: item.sku?.trim() || product || "GitHub",
        quantity,
        unit: item.unitType ?? null,
        costUsd: cost,
        source: "github:billing-usage",
        externalRef: [
          owner,
          day.toISOString().slice(0, 10),
          item.sku ?? product ?? "?",
          repoFull || "shared",
        ].join("|"),
        raw: {
          owner,
          product,
          sku: item.sku,
          unitType: item.unitType,
          pricePerUnit: item.pricePerUnit,
          grossAmount: item.grossAmount,
          discountAmount: item.discountAmount,
          netAmount: item.netAmount,
          repositoryName: item.repositoryName,
          organizationName: item.organizationName,
        },
        chargedOn: day,
      });
    }

    log.push(
      `${owner}: ${items.length} usage items, ${attributed} tied to a repo, $${ownerCost.toFixed(2)} net.`,
    );
  }

  return { lines, log };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
