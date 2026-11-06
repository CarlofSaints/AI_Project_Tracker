import Link from "next/link";
import { prisma } from "@/lib/db";
import { disconnectAnalytics } from "./actions";
import { AnalyticsAddSite } from "@/components/analytics-add-site";
import { AnalyticsGuide } from "@/components/analytics-guide";
import {
  PERIODS,
  analyticsConfigured,
  fetchSiteReport,
  getAccessToken,
  type PeriodDays,
  type SiteReport,
} from "@/lib/google-analytics";

// shortcut: reads Google live on each view (one call per site), unlike the rest of the
// app which reads Postgres. Move to a nightly cron if the list gets slow or we want history.
export const dynamic = "force-dynamic";

function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
}

function Ranking({ title, rows }: { title: string; rows: SiteReport["topPages"] }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-neutral-500 dark:text-neutral-400">{title}</h3>
      <ul className="mt-1 space-y-1 text-sm">
        {rows.map((row) => (
          <li key={row.label} className="flex justify-between gap-4">
            <span className="truncate">{row.label}</span>
            <span className="tabular-nums">{row.value.toLocaleString("en-ZA")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: requested } = await searchParams;
  const days = PERIODS.find((period) => String(period) === requested) ?? (28 as PeriodDays);

  const [sites, available] = await Promise.all([
    prisma.project.findMany({
      where: { ga4PropertyId: { not: null }, hidden: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, productionUrl: true, ga4PropertyId: true },
    }),
    prisma.project.findMany({
      where: { ga4PropertyId: null, hidden: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  const configured = analyticsConfigured();
  let signInError: string | null = null;
  let reports: PromiseSettledResult<SiteReport>[] = [];
  if (configured && sites.length > 0) {
    try {
      const token = await getAccessToken();
      reports = await Promise.allSettled(
        sites.map((site) => fetchSiteReport(site.ga4PropertyId!, days, token)),
      );
    } catch (error) {
      signInError = error instanceof Error ? error.message : "Could not sign in to Google.";
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">Website traffic from Google Analytics.</p>
        </div>
        <nav aria-label="Period" className="flex gap-1">
          {PERIODS.map((period) => (
            <Link
              key={period}
              href={`/analytics?days=${period}`}
              aria-current={period === days ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm ${
                period === days
                  ? "bg-[var(--brand-soft)] text-[var(--brand-text)]"
                  : "text-neutral-600 dark:text-neutral-400"
              }`}
            >
              {period} days
            </Link>
          ))}
        </nav>
      </div>

      {!configured && (
        <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Google is not connected yet: GOOGLE_ANALYTICS_CREDENTIALS is not set, so no figures can load.
        </p>
      )}
      {signInError && (
        <p
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          {signInError}
        </p>
      )}

      <AnalyticsAddSite projects={available} />
      <AnalyticsGuide />

      {sites.length === 0 && (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No projects added yet.</p>
      )}

      <div className="space-y-4">
        {sites.map((site, index) => {
          const result = reports[index];
          const report = result?.status === "fulfilled" ? result.value : null;
          const failure = result?.status === "rejected" ? String(result.reason?.message ?? result.reason) : null;
          return (
            <section
              key={site.id}
              className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <h2 className="font-semibold">{site.name}</h2>
                  {site.productionUrl && (
                    <a
                      href={`https://${site.productionUrl}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[var(--brand-text)] hover:underline"
                    >
                      {site.productionUrl}
                    </a>
                  )}
                </div>
                <form action={disconnectAnalytics.bind(null, site.id)}>
                  <button type="submit" className="text-xs text-neutral-500 hover:underline dark:text-neutral-400">
                    Remove from this page
                  </button>
                </form>
              </div>

              {failure && (
                <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {failure}
                </p>
              )}
              {report && report.sessions === 0 && (
                <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
                  No visits recorded in the last {days} full days. Today only shows from tomorrow.
                </p>
              )}
              {report && report.sessions > 0 && (
                <>
                  <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <Figure label="Visitors" value={report.visitors.toLocaleString("en-ZA")} />
                    <Figure label="Visits" value={report.sessions.toLocaleString("en-ZA")} />
                    <Figure label="Page views" value={report.pageViews.toLocaleString("en-ZA")} />
                    <Figure label="Time per visit" value={formatDuration(report.avgSessionSeconds)} />
                    <Figure label="Left straight away" value={`${Math.round(report.bounceRate * 100)}%`} />
                  </div>
                  <div className="mt-4 grid gap-6 sm:grid-cols-2">
                    <Ranking title="Top pages" rows={report.topPages} />
                    <Ranking title="Where they came from" rows={report.topSources} />
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
