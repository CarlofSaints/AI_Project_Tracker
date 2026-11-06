import { createSign } from "node:crypto";

const GOOGLE_TIMEOUT_MS = 10_000;

export const PERIODS = [7, 28, 90] as const;
export type PeriodDays = (typeof PERIODS)[number];

export interface SiteReport {
  visitors: number;
  sessions: number;
  pageViews: number;
  avgSessionSeconds: number;
  bounceRate: number;
  topPages: { label: string; value: number }[];
  topSources: { label: string; value: number }[];
}

interface GaReport {
  rows?: { dimensionValues?: { value: string }[]; metricValues: { value: string }[] }[];
}

export function analyticsConfigured() {
  return Boolean(process.env.GOOGLE_ANALYTICS_CREDENTIALS);
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

/** Service-account sign-in. Hand-rolled because the SDK is a large dependency for one JWT. */
export async function getAccessToken(): Promise<string> {
  let credentials: { client_email: string; private_key: string };
  try {
    credentials = JSON.parse(process.env.GOOGLE_ANALYTICS_CREDENTIALS ?? "");
  } catch {
    // Never surface the parse error: Node quotes a slice of the key in it.
    throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not valid JSON");
  }
  if (!credentials?.client_email || !credentials.private_key) {
    throw new Error("GOOGLE_ANALYTICS_CREDENTIALS is not a service-account key file");
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64Url(
      JSON.stringify({
        iss: credentials.client_email,
        scope: "https://www.googleapis.com/auth/analytics.readonly",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join(".");
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url");
  } catch {
    throw new Error("The private key in GOOGLE_ANALYTICS_CREDENTIALS could not be read");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new Error(`Google sign-in failed (${response.status}): ${body?.error_description ?? "no details"}`);
  }
  return body.access_token;
}

function toRanking(report: GaReport | undefined) {
  return (report?.rows ?? []).map((row) => ({
    label: row.dimensionValues?.[0]?.value || "(not set)",
    value: Number(row.metricValues[0]?.value ?? 0),
  }));
}

/** Pure, so it can be tested without Google. A property with no visits yet returns no rows at all. */
export function parseReports(reports: GaReport[]): SiteReport {
  const totals = reports[0]?.rows?.[0]?.metricValues.map((metric) => Number(metric.value)) ?? [];
  return {
    visitors: totals[0] ?? 0,
    sessions: totals[1] ?? 0,
    pageViews: totals[2] ?? 0,
    avgSessionSeconds: totals[3] ?? 0,
    bounceRate: totals[4] ?? 0,
    topPages: toRanking(reports[1]),
    topSources: toRanking(reports[2]),
  };
}

export async function fetchSiteReport(
  propertyId: string,
  days: PeriodDays,
  accessToken: string,
): Promise<SiteReport> {
  // Ends yesterday: today is partial, and "7daysAgo" to "today" would be 8 dates.
  const dateRanges = [{ startDate: `${days}daysAgo`, endDate: "yesterday" }];
  const ranking = (dimension: string, metric: string) => ({
    dateRanges,
    dimensions: [{ name: dimension }],
    metrics: [{ name: metric }],
    orderBys: [{ metric: { metricName: metric }, desc: true }],
    limit: 5,
  });

  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            dateRanges,
            metrics: ["activeUsers", "sessions", "screenPageViews", "averageSessionDuration", "bounceRate"].map(
              (name) => ({ name }),
            ),
          },
          ranking("pagePath", "screenPageViews"),
          ranking("sessionSource", "sessions"),
        ],
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    },
  );

  const body = await response.json().catch(() => null);
  // Google's own message, because a 403 can mean a missing Viewer or a disabled API.
  if (!response.ok) {
    throw new Error(`Google Analytics failed (${response.status}): ${body?.error?.message ?? "no details"}`);
  }
  return parseReports(body?.reports ?? []);
}
