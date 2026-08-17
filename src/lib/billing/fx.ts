/**
 * USD → ZAR for a billing period.
 *
 * The rate is pinned to a date and stored on the period, never fetched at
 * render time. An invoice that quietly re-prices itself every time the rand
 * moves is not an invoice — so once a month has a rate, that rate is the
 * answer until someone deliberately changes it.
 *
 * Frankfurter publishes ECB reference rates, needs no API key, and answers for
 * a specific date (rolling back to the previous publishing day on weekends and
 * holidays). If it is unreachable the UI falls back to manual entry rather
 * than guessing — a wrong rate is worse than a missing one.
 */

const FRANKFURTER = "https://api.frankfurter.app";

export interface FxLookup {
  rate: number;
  /** The date the rate actually came from, which may precede the one asked for. */
  effectiveOn: string;
  source: string;
}

export async function fetchUsdToZar(onDate: string, currency = "ZAR"): Promise<FxLookup> {
  const url = `${FRANKFURTER}/${onDate}?from=USD&to=${currency}`;
  const res = await fetch(url, { cache: "no-store" });

  if (!res.ok) {
    throw new Error(`FX lookup failed (${res.status}) for ${onDate}`);
  }

  const data = (await res.json()) as {
    date?: string;
    rates?: Record<string, number>;
  };

  const rate = data.rates?.[currency];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX lookup returned no usable ${currency} rate for ${onDate}`);
  }

  return { rate, effectiveOn: data.date ?? onDate, source: "frankfurter.app" };
}
