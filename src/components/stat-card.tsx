export type StatAccent = "gradient" | "brand" | "brand2" | "warn";

const ACCENT_BAR: Record<StatAccent, string> = {
  gradient: "bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)]",
  brand: "bg-[var(--brand)]",
  brand2: "bg-[var(--brand-2)]",
  // Amber sits outside the brand palette on purpose: it means "money nobody is
  // paying for", and that should never be mistaken for a decorative accent.
  warn: "bg-amber-500",
};

export function StatCard({
  label,
  value,
  hint,
  accent = "gradient",
}: {
  label: string;
  /** Pre-formatted strings are allowed so currency stays in one place. */
  value: number | string;
  hint?: string;
  accent?: StatAccent;
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      {/* Colour rides the top edge rather than the number itself — the figure is
          the thing people read, so it keeps maximum contrast. */}
      <div aria-hidden className={`absolute inset-x-0 top-0 h-1 ${ACCENT_BAR[accent]}`} />
      <div className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint ? (
        <div className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">{hint}</div>
      ) : null}
    </div>
  );
}
