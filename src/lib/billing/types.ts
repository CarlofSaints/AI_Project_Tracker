/**
 * The contract every cost collector implements.
 *
 * Collectors are pure: they call a vendor API and shape the answer. They never
 * touch the database, and they never decide which project a cost belongs to —
 * they only say how the project could be identified. The orchestrator
 * (src/lib/billing/ingest.ts) resolves those keys against our own tables.
 *
 * That split is what makes the attribution auditable. A collector cannot
 * quietly guess, and anything it hands back that we cannot resolve surfaces as
 * an unmapped account for Carl to map, rather than vanishing into a total.
 */

import type { CostKind, Vendor } from "@/generated/prisma/enums";

/**
 * How a collector names the project behind a charge.
 *
 * Vercel and GitHub carry our own identifiers in their billing data, so they
 * resolve directly. Everything else reports against an identity only Carl can
 * tie to a project — hence `vendorLink`, which resolves through the
 * VendorProjectLink table and fails loudly when there is no mapping.
 */
export type ProjectKey =
  | { by: "vercelProjectId"; value: string; label?: string }
  | { by: "gitRepo"; owner: string | null; repo: string; label?: string }
  | { by: "vendorLink"; vendor: Vendor; externalId: string; label?: string };

export interface CollectedLine {
  vendor: Vendor;
  /** Only meaningful when vendor is OTHER. */
  vendorLabel?: string | null;
  kind: CostKind;
  /**
   * Null for BASE_FEE lines (nothing to attribute) and for metered lines the
   * vendor could not attribute either. A metered line arriving with a key that
   * fails to resolve becomes an unmapped account, not a null projectId.
   */
  projectKey: ProjectKey | null;
  service: string;
  quantity: number | null;
  unit: string | null;
  /** USD. Zero is a legitimate value — a free-tier line still evidences usage. */
  costUsd: number;
  source: string;
  externalRef?: string | null;
  raw?: unknown;
  chargedOn: Date;
}

export interface CollectResult {
  lines: CollectedLine[];
  log: string[];
}

/** Inclusive start, exclusive end — the calendar month being collected. */
export interface PeriodWindow {
  start: Date;
  end: Date;
  label: string;
}

/**
 * Thrown when a collector cannot run at all (missing token, 401, plan does not
 * expose the endpoint). Distinct from "ran and found nothing", which is a
 * SUCCESS with zero lines and is a completely different signal.
 */
export class CollectorUnavailable extends Error {
  constructor(
    readonly vendor: Vendor,
    message: string,
  ) {
    super(message);
    this.name = "CollectorUnavailable";
  }
}

export const VENDOR_LABELS: Record<Vendor, string> = {
  VERCEL: "Vercel",
  GITHUB: "GitHub",
  ANTHROPIC: "Anthropic",
  RESEND: "Resend",
  GOOGLE: "Google",
  OTHER: "Other",
};

/**
 * How far each vendor can be trusted to attribute a cost to one project, which
 * is the single most important thing to be honest about on a billing screen.
 *
 *  exact      — the vendor's own billing data names our project or repo.
 *  mapped     — attributable, but only via a mapping Carl maintains by hand.
 *  manual     — no usable API; the numbers are typed in.
 */
export type AttributionGrade = "exact" | "mapped" | "manual";

export const VENDOR_ATTRIBUTION: Record<Vendor, AttributionGrade> = {
  VERCEL: "exact",
  GITHUB: "exact",
  ANTHROPIC: "mapped",
  RESEND: "mapped",
  GOOGLE: "mapped",
  OTHER: "manual",
};

export const ATTRIBUTION_NOTE: Record<AttributionGrade, string> = {
  exact: "The vendor's billing data names the project directly.",
  mapped: "Attributed through a mapping you maintain — accurate only while it is complete.",
  manual: "Entered by hand.",
};
