/**
 * Money and quantity formatting, kept free of any database import so client
 * components can use the same helpers the server rollup does. If these lived in
 * rollup.ts, importing `formatUsd` into a client component would pull Prisma
 * into the browser bundle.
 */

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function basisPointsToPercent(bp: number): number {
  return bp / 100;
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatLocal(value: number, currency: string): string {
  try {
    return value.toLocaleString("en-ZA", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  } catch {
    // An unrecognised currency code should degrade to a readable number rather
    // than throwing inside a render.
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatQuantity(quantity: number | null, unit: string | null): string {
  if (quantity === null) return "—";
  const rounded =
    Math.abs(quantity) >= 1000 ? Math.round(quantity) : Math.round(quantity * 100) / 100;
  return `${rounded.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`;
}

export function formatPercent(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}
