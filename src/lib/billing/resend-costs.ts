/**
 * Resend cost collector.
 *
 * Resend has no usage or billing endpoint — the only thing it will tell you is
 * what it sent. So this walks `GET /emails` backwards from the newest message
 * until it passes the start of the period, and counts sends per sending domain
 * per day. The sending domain is the attribution key: map each domain to a
 * project in VendorProjectLink and every send lands on the right project.
 *
 * Cost is deliberately zero by default. Resend charges a plan fee, not a
 * per-email rate, so pricing a send would be inventing a number. The plan fee
 * arrives as a base fee to split across clients by hand, and the per-project
 * send counts are the evidence for how to split it. If Carl later wants sends
 * priced directly, `BillingSettings.resendUsdPerEmail` turns them into real
 * money without touching this file.
 *
 * The walk is bounded. Listing is cursor-paginated with no date filter, so on a
 * busy account an unbounded backwards scan would be the slowest thing in the
 * ingest by an order of magnitude — the cap is reported in the log rather than
 * being an invisible truncation.
 */

import {
  CollectorUnavailable,
  type CollectResult,
  type CollectedLine,
  type PeriodWindow,
} from "./types";

const API = "https://api.resend.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 120; // 12,000 emails — generous for a month, still bounded

interface ResendEmail {
  id?: string;
  from?: string;
  created_at?: string;
  last_event?: string;
  subject?: string;
}

/** "Acme <hello@mail.example.com>" → "mail.example.com" */
export function sendingDomain(from: string | undefined): string | null {
  if (!from) return null;
  const angle = /<([^>]+)>/.exec(from);
  const address = (angle ? angle[1] : from).trim();
  const at = address.lastIndexOf("@");
  if (at === -1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

export async function collectResend(
  window: PeriodWindow,
  usdPerEmail = 0,
): Promise<CollectResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new CollectorUnavailable(
      "RESEND",
      "RESEND_API_KEY is not set. A key with read access to the team's emails is enough.",
    );
  }

  const log: string[] = [];
  // domain → day → count
  const tally = new Map<string, Map<string, number>>();

  let after: string | undefined;
  let pages = 0;
  let scanned = 0;
  let inPeriod = 0;
  let reachedStart = false;
  let unknownDomain = 0;

  while (pages < MAX_PAGES) {
    const url = new URL("/emails", API);
    url.searchParams.set("limit", String(PAGE_SIZE));
    if (after) url.searchParams.set("after", after);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new CollectorUnavailable(
          "RESEND",
          `${res.status} from Resend. The API key needs permission to list emails. Detail: ${body.slice(0, 200)}`,
        );
      }
      if (res.status === 404) {
        throw new CollectorUnavailable(
          "RESEND",
          "Resend returned 404 for GET /emails — this account or key may predate the list-emails endpoint.",
        );
      }
      throw new Error(`Resend ${res.status} on /emails: ${body.slice(0, 300)}`);
    }

    const payload = (await res.json()) as { data?: ResendEmail[] };
    const batch = payload.data ?? [];
    pages++;
    scanned += batch.length;

    for (const email of batch) {
      if (!email.created_at) continue;
      const sentAt = new Date(email.created_at);
      if (Number.isNaN(sentAt.getTime())) continue;

      // The list runs newest-first, so anything before the window means we have
      // walked past the period and can stop after this page.
      if (sentAt < window.start) {
        reachedStart = true;
        continue;
      }
      if (sentAt >= window.end) continue; // newer than the period being collected

      const domain = sendingDomain(email.from);
      if (!domain) {
        unknownDomain++;
        continue;
      }

      inPeriod++;
      const day = sentAt.toISOString().slice(0, 10);
      const byDay = tally.get(domain) ?? new Map<string, number>();
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      tally.set(domain, byDay);
    }

    const last = batch[batch.length - 1];
    if (reachedStart || batch.length < PAGE_SIZE || !last?.id) break;
    after = last.id;
  }

  if (pages >= MAX_PAGES && !reachedStart) {
    log.push(
      `Stopped after ${MAX_PAGES} pages (${scanned} emails) without reaching the start of the period — counts for this month are a floor, not a total.`,
    );
  }
  if (unknownDomain > 0) {
    log.push(`${unknownDomain} email(s) had an unreadable From address and were not counted.`);
  }

  const lines: CollectedLine[] = [];

  for (const [domain, byDay] of tally) {
    for (const [day, count] of byDay) {
      lines.push({
        vendor: "RESEND",
        kind: "METERED",
        projectKey: { by: "vendorLink", vendor: "RESEND", externalId: domain, label: domain },
        service: `Emails sent — ${domain}`,
        quantity: count,
        unit: "emails",
        costUsd: count * usdPerEmail,
        source: "resend:emails",
        externalRef: `${day}|${domain}`,
        raw: { domain, day, count, usdPerEmail },
        chargedOn: new Date(`${day}T00:00:00.000Z`),
      });
    }
  }

  log.push(
    `${inPeriod} email(s) in period across ${tally.size} sending domain(s); scanned ${scanned} over ${pages} page(s).` +
      (usdPerEmail === 0
        ? " Priced at $0 — Resend's plan fee is a base fee, split it by client."
        : ` Priced at $${usdPerEmail} per email.`),
  );

  return { lines, log };
}

/** Verified sending domains, so the mapping UI can offer a real list. */
export async function listResendDomains(): Promise<Array<{ id: string; name: string }>> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return [];

  try {
    const res = await fetch(new URL("/domains", API), {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<{ name?: string; status?: string }> };
    return (data.data ?? [])
      .filter((d): d is { name: string; status?: string } => Boolean(d.name))
      .map((d) => ({ id: d.name.toLowerCase(), name: `${d.name}${d.status ? ` (${d.status})` : ""}` }));
  } catch {
    return [];
  }
}
