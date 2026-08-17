/**
 * Anthropic cost collector.
 *
 * This is the vendor where attribution has to be earned. Anthropic bills an
 * organisation, and the finest grain the cost report offers is the WORKSPACE —
 * there is no project dimension and no tagging. So the only way a project's
 * Claude spend can be known is if that project's traffic runs through its own
 * workspace, and that workspace is mapped to the project in VendorProjectLink.
 *
 * Two hard prerequisites, both of which fail loudly rather than silently:
 *
 *  1. An ADMIN key (`sk-ant-admin01-…`), not a normal API key. The Admin API is
 *     unavailable to individual accounts — the account has to be set up as an
 *     Organization in Console → Settings → Organization.
 *  2. One workspace per project (or per client), each mapped here. Everything
 *     running out of one shared workspace is one undifferentiated number, and
 *     no amount of code can split it after the fact.
 *
 * Where a workspace is unmapped the cost still lands, unattributed and visible,
 * so a month is never quietly understated.
 *
 * Two endpoints are read:
 *  * /cost_report  — the money. Amounts are decimal strings in CENTS.
 *  * /usage_report — the tokens, recorded at zero cost as evidence of what a
 *    project actually consumed. Useful on its own, and the only usable basis if
 *    Carl ever wants to apportion a shared workspace by consumption.
 */

import {
  CollectorUnavailable,
  type CollectResult,
  type CollectedLine,
  type PeriodWindow,
} from "./types";

const API = "https://api.anthropic.com";

/** Sentinel for the default workspace, which the API reports as a null id. */
export const DEFAULT_WORKSPACE = "__default__";

interface CostResult {
  amount?: string;
  currency?: string;
  cost_type?: string | null;
  description?: string | null;
  model?: string | null;
  service_tier?: string | null;
  token_type?: string | null;
  context_window?: string | null;
  workspace_id?: string | null;
}

interface UsageResult {
  workspace_id?: string | null;
  api_key_id?: string | null;
  model?: string | null;
  uncached_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  server_tool_use?: { web_search_requests?: number };
}

interface Bucket<T> {
  starting_at?: string;
  ending_at?: string;
  results?: T[];
}

interface Report<T> {
  data?: Bucket<T>[];
  has_more?: boolean;
  next_page?: string | null;
}

function adminHeaders(key: string): HeadersInit {
  return {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    // Helps Anthropic see how this integration behaves, and costs nothing.
    "User-Agent": "AI-Project-CRM-Billing/1.0 (+https://github.com/CarlofSaints/AI_Project_Tracker)",
  };
}

/**
 * Walks every page of a report. Both endpoints paginate by time bucket, and a
 * 1d bucket width caps at 31 buckets per page — so a calendar month is normally
 * one page, but the loop is here because "normally" is not "always".
 */
async function fetchAllPages<T>(
  path: string,
  params: URLSearchParams,
  key: string,
): Promise<Bucket<T>[]> {
  const buckets: Bucket<T>[] = [];
  let page: string | null = null;

  for (let guard = 0; guard < 25; guard++) {
    const url = new URL(path, API);
    for (const [k, v] of params) url.searchParams.append(k, v);
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, { headers: adminHeaders(key), cache: "no-store" });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new CollectorUnavailable(
          "ANTHROPIC",
          `${res.status} from the Admin API. This endpoint needs an Admin key (sk-ant-admin01-…) on an Organization account — it is unavailable to individual accounts. Detail: ${body.slice(0, 200)}`,
        );
      }
      throw new Error(`Anthropic ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as Report<T>;
    buckets.push(...(data.data ?? []));

    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }

  return buckets;
}

export async function collectAnthropic(window: PeriodWindow): Promise<CollectResult> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    throw new CollectorUnavailable(
      "ANTHROPIC",
      "ANTHROPIC_ADMIN_KEY is not set. Create one at Console → Settings → Admin keys; a normal API key will not work.",
    );
  }

  const log: string[] = [];
  const lines: CollectedLine[] = [];

  // ------------------------------------------------------------- cost
  const costParams = new URLSearchParams({
    starting_at: window.start.toISOString(),
    ending_at: window.end.toISOString(),
    bucket_width: "1d",
    limit: "31",
  });
  costParams.append("group_by[]", "workspace_id");
  costParams.append("group_by[]", "description");

  const costBuckets = await fetchAllPages<CostResult>(
    "/v1/organizations/cost_report",
    costParams,
    key,
  );

  let totalUsd = 0;
  const workspacesSeen = new Set<string>();

  for (const bucket of costBuckets) {
    const chargedOn = bucket.starting_at ? new Date(bucket.starting_at) : window.start;
    if (Number.isNaN(chargedOn.getTime())) continue;

    for (const result of bucket.results ?? []) {
      // `amount` is a decimal string in the currency's lowest unit — cents.
      const cents = Number.parseFloat(result.amount ?? "0");
      if (!Number.isFinite(cents) || cents === 0) continue;
      const costUsd = cents / 100;
      totalUsd += costUsd;

      const workspace = result.workspace_id ?? DEFAULT_WORKSPACE;
      workspacesSeen.add(workspace);

      lines.push({
        vendor: "ANTHROPIC",
        kind: "METERED",
        projectKey: {
          by: "vendorLink",
          vendor: "ANTHROPIC",
          externalId: workspace,
          label:
            workspace === DEFAULT_WORKSPACE ? "Default workspace" : workspace,
        },
        service: result.description?.trim() || result.model || result.cost_type || "Claude usage",
        quantity: null,
        unit: null,
        costUsd,
        source: "anthropic:cost_report",
        externalRef: [
          chargedOn.toISOString().slice(0, 10),
          workspace,
          result.description ?? result.cost_type ?? "?",
          result.token_type ?? "",
          result.context_window ?? "",
          result.service_tier ?? "",
        ].join("|"),
        raw: result,
        chargedOn,
      });
    }
  }

  log.push(
    `cost_report: ${costBuckets.length} daily buckets, ${workspacesSeen.size} workspace(s), $${totalUsd.toFixed(2)}.`,
  );

  // ------------------------------------------------------------- tokens
  // Recorded at zero cost. The money is already counted above; this exists so
  // the billing page can show what a project actually consumed, not just what
  // it was charged.
  try {
    const usageParams = new URLSearchParams({
      starting_at: window.start.toISOString(),
      ending_at: window.end.toISOString(),
      bucket_width: "1d",
      limit: "31",
    });
    usageParams.append("group_by[]", "workspace_id");
    usageParams.append("group_by[]", "model");

    const usageBuckets = await fetchAllPages<UsageResult>(
      "/v1/organizations/usage_report/messages",
      usageParams,
      key,
    );

    let totalTokens = 0;

    for (const bucket of usageBuckets) {
      const chargedOn = bucket.starting_at ? new Date(bucket.starting_at) : window.start;
      if (Number.isNaN(chargedOn.getTime())) continue;

      for (const result of bucket.results ?? []) {
        const tokens =
          (result.uncached_input_tokens ?? 0) +
          (result.cache_read_input_tokens ?? 0) +
          (result.output_tokens ?? 0) +
          (result.cache_creation?.ephemeral_1h_input_tokens ?? 0) +
          (result.cache_creation?.ephemeral_5m_input_tokens ?? 0);
        if (tokens === 0) continue;
        totalTokens += tokens;

        const workspace = result.workspace_id ?? DEFAULT_WORKSPACE;
        workspacesSeen.add(workspace);

        lines.push({
          vendor: "ANTHROPIC",
          kind: "METERED",
          projectKey: {
            by: "vendorLink",
            vendor: "ANTHROPIC",
            externalId: workspace,
            label: workspace === DEFAULT_WORKSPACE ? "Default workspace" : workspace,
          },
          service: `${result.model ?? "Claude"} — tokens`,
          quantity: tokens,
          unit: "tokens",
          costUsd: 0,
          source: "anthropic:usage_report",
          externalRef: [
            chargedOn.toISOString().slice(0, 10),
            workspace,
            result.model ?? "?",
            "tokens",
          ].join("|"),
          raw: result,
          chargedOn,
        });
      }
    }

    log.push(`usage_report: ${totalTokens.toLocaleString("en-US")} tokens (recorded at zero cost).`);
  } catch (err) {
    // Token counts are a nice-to-have; losing them must not lose the money.
    log.push(`usage_report skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (workspacesSeen.size === 1 && workspacesSeen.has(DEFAULT_WORKSPACE)) {
    log.push(
      "All spend is in the default workspace, so it cannot be split between projects. Create one workspace per project (or per client) and move each project's API key into it.",
    );
  }

  return { lines, log };
}

/** Workspace names for the mapping UI, so the picker isn't a list of raw ids. */
export async function listAnthropicWorkspaces(): Promise<
  Array<{ id: string; name: string }>
> {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) return [];

  try {
    const url = new URL("/v1/organizations/workspaces?limit=100", API);
    const res = await fetch(url, { headers: adminHeaders(key), cache: "no-store" });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    return (data.data ?? [])
      .filter((w): w is { id: string; name: string } => Boolean(w.id))
      .map((w) => ({ id: w.id, name: w.name ?? w.id }));
  } catch {
    return [];
  }
}
