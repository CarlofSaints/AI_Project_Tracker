import { NextResponse } from "next/server";
import { runCostIngest } from "@/lib/billing/ingest";
import { currentPeriod, previousPeriod, parsePeriodLabel } from "@/lib/billing/period";
import { prisma } from "@/lib/db";

// Four vendor APIs, one of them paging backwards through an email list.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Cron entry point for cost collection. Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET`.
 *
 * The check is unconditional and the secret must be present — a guard that
 * passes when the secret is missing is the same as no guard, and this endpoint
 * hammers four paid APIs.
 *
 * Collects the current month every run, and also the previous month for the
 * first ten days of a new one: vendors restate figures as a month settles, and
 * a month that stopped being collected at midnight on the 1st would be frozen
 * mid-settlement without anyone noticing.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get("period");

  const targets: Array<{ year: number; month: number }> = [];

  if (requested) {
    const parsed = parsePeriodLabel(requested);
    if (!parsed) {
      return NextResponse.json({ error: `"${requested}" is not a YYYY-MM period` }, { status: 400 });
    }
    targets.push(parsed);
  } else {
    const now = new Date();
    const current = currentPeriod(now);
    targets.push(current);
    if (now.getUTCDate() <= 10) {
      targets.push(previousPeriod(current.year, current.month));
    }
  }

  const results = [];
  let anyFailed = false;

  for (const target of targets) {
    try {
      const result = await runCostIngest(target);
      results.push(result);
      if (result.vendors.some((vendor) => vendor.status === "FAILED")) anyFailed = true;
    } catch (err) {
      anyFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      // A closed period is the expected reason a target is skipped, not a fault.
      results.push({
        periodLabel: `${target.year}-${String(target.month).padStart(2, "0")}`,
        vendors: [],
        fx: { rate: null, note: message },
        skipped: message,
      });
    }
  }

  return NextResponse.json({ ok: !anyFailed, results }, { status: anyFailed ? 207 : 200 });
}

/**
 * Manual trigger for one period, used by the "Collect costs" button's server
 * action path in development. Same auth as the cron.
 */
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { period?: string };
  const parsed = body.period ? parsePeriodLabel(body.period) : currentPeriod();
  if (!parsed) {
    return NextResponse.json({ error: `"${body.period}" is not a YYYY-MM period` }, { status: 400 });
  }

  const result = await runCostIngest(parsed);
  const runs = await prisma.costIngestRun.count({
    where: { period: { year: parsed.year, month: parsed.month } },
  });

  return NextResponse.json({ ...result, totalRunsRecorded: runs });
}
