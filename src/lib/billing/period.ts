/**
 * Billing periods are calendar months in UTC.
 *
 * Every vendor above reports in UTC, so resolving a period in local time would
 * push charges made late on the last day of the month into the next one — the
 * kind of drift that only shows up as an invoice that doesn't reconcile.
 */

import type { PeriodWindow } from "./types";

export function periodLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function parsePeriodLabel(label: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(label.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export function periodWindow(year: number, month: number): PeriodWindow {
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
    label: periodLabel(year, month),
  };
}

export function currentPeriod(now = new Date()): { year: number; month: number } {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

/** The month before the given one — what a month-end close usually targets. */
export function previousPeriod(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function periodDisplay(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

/** ISO date (no time) for a day inside the period — what FX APIs want. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The date an FX rate should be pinned to: the last day of the period, or
 * today if the period is still running (a rate for a future date does not
 * exist, and asking for one returns the wrong thing rather than an error).
 */
export function fxRateDate(year: number, month: number, now = new Date()): Date {
  const lastDay = new Date(Date.UTC(year, month, 0));
  return lastDay > now ? now : lastDay;
}
