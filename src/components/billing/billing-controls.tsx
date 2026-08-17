"use client";

/**
 * Settings, the exchange rate, and hand-entered costs.
 *
 * The manual entry path is not a fallback — it is the whole answer for Google
 * and for anything else that only ever shows up on a card statement. Without
 * it the billing page would quietly under-report every month by exactly the
 * amount it cannot see.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { CostKind, Vendor } from "@/generated/prisma/enums";
import type { PeriodRollup } from "@/lib/billing/rollup";
import { formatUsd, formatLocal } from "@/lib/billing/format";
import {
  addManualCostLine,
  deleteCostLine,
  setPeriodRate,
  refetchPeriodRate,
  updateBillingSettings,
} from "@/app/billing/actions";

const VENDORS: Vendor[] = ["GOOGLE", "OTHER", "VERCEL", "GITHUB", "ANTHROPIC", "RESEND"];

export interface ManualLine {
  id: string;
  vendor: Vendor;
  vendorLabel: string | null;
  kind: CostKind;
  service: string;
  projectName: string | null;
  costUsd: number;
}

export function BillingControls({
  rollup,
  projects,
  manualLines,
  defaultMarkupBasisPoints,
  resendUsdPerEmail,
}: {
  rollup: PeriodRollup;
  projects: Array<{ id: string; name: string }>;
  manualLines: ManualLine[];
  defaultMarkupBasisPoints: number;
  resendUsdPerEmail: number;
}) {
  const [tab, setTab] = useState<"rate" | "manual" | "settings">("rate");

  return (
    <section className="rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex gap-1 border-b border-neutral-200 px-5 pt-4 dark:border-neutral-800">
        {(
          [
            ["rate", "Exchange rate"],
            ["manual", "Add a cost by hand"],
            ["settings", "Settings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-t-md px-3 py-2 text-sm transition ${
              tab === id
                ? "bg-neutral-100 font-medium dark:bg-neutral-800"
                : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="p-5">
        {tab === "rate" ? <RatePanel rollup={rollup} /> : null}
        {tab === "manual" ? (
          <ManualPanel rollup={rollup} projects={projects} manualLines={manualLines} />
        ) : null}
        {tab === "settings" ? (
          <SettingsPanel
            defaultMarkupBasisPoints={defaultMarkupBasisPoints}
            resendUsdPerEmail={resendUsdPerEmail}
            currency={rollup.currency}
          />
        ) : null}
      </div>
    </section>
  );
}

function RatePanel({ rollup }: { rollup: PeriodRollup }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [value, setValue] = useState(rollup.period.usdToZar?.toString() ?? "");
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        One rate for {rollup.period.display}, applied to every figure on this page. Locking it per
        month is what stops a sent invoice re-pricing itself every time the rand moves.
      </p>

      {rollup.period.usdToZar !== null ? (
        <p className="text-sm">
          <span className="font-semibold tabular-nums">
            1 USD = {rollup.period.usdToZar.toFixed(4)} {rollup.currency}
          </span>{" "}
          <span className="text-neutral-500">
            ({rollup.period.rateSource ?? "manual"}
            {rollup.period.rateSetAt
              ? `, set ${new Date(rollup.period.rateSetAt).toLocaleDateString("en-ZA")}`
              : ""}
            )
          </span>
        </p>
      ) : (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          No rate set — every {rollup.currency} figure is hidden until there is one.
        </p>
      )}

      {!rollup.period.closed ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="number"
            step="0.0001"
            min="0"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="18.4500"
            className="w-32 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await setPeriodRate(
                  rollup.period.id,
                  Number.parseFloat(value),
                );
                setMessage(result.ok ? "Rate saved." : (result.error ?? "Failed"));
                router.refresh();
              })
            }
            className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            Save rate
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await refetchPeriodRate(rollup.period.id);
                setMessage(
                  result.ok
                    ? `Fetched ${result.rate?.toFixed(4)} (${result.effectiveOn}).`
                    : (result.error ?? "Failed"),
                );
                router.refresh();
              })
            }
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
          >
            Fetch month-end rate
          </button>
          {message ? <span className="text-sm text-neutral-500">{message}</span> : null}
        </div>
      ) : null}

      {rollup.period.usdToZar !== null ? (
        <p className="text-sm text-neutral-500">
          Total billable {formatUsd(rollup.totals.billableUsd)} ={" "}
          <span className="font-medium">
            {formatLocal(rollup.totals.billableLocal ?? 0, rollup.currency)}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function ManualPanel({
  rollup,
  projects,
  manualLines,
}: {
  rollup: PeriodRollup;
  projects: Array<{ id: string; name: string }>;
  manualLines: ManualLine[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [vendor, setVendor] = useState<Vendor>("GOOGLE");
  const [vendorLabel, setVendorLabel] = useState("");
  const [kind, setKind] = useState<CostKind>("METERED");
  const [projectId, setProjectId] = useState("");
  const [service, setService] = useState("");
  const [cost, setCost] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  if (rollup.period.closed) {
    return (
      <p className="text-sm text-neutral-500">
        {rollup.period.display} is closed. Re-open it to add a cost.
      </p>
    );
  }

  function submit() {
    setMessage(null);
    startTransition(async () => {
      const result = await addManualCostLine({
        periodId: rollup.period.id,
        vendor,
        vendorLabel: vendor === "OTHER" ? vendorLabel : null,
        kind,
        projectId: kind === "METERED" ? projectId || null : null,
        service,
        quantity: quantity ? Number.parseFloat(quantity) : null,
        unit: unit || null,
        costUsd: Number.parseFloat(cost),
      });

      if (result.ok) {
        setMessage({ tone: "ok", text: "Cost added." });
        setService("");
        setCost("");
        setQuantity("");
        setUnit("");
      } else {
        setMessage({ tone: "bad", text: result.error ?? "Could not add that cost" });
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        For anything without a usable API — a Google Cloud bill, a one-off supplier. Entered in USD
        and never touched by the collectors.
      </p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">Vendor</span>
          <select
            value={vendor}
            onChange={(event) => setVendor(event.target.value as Vendor)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {VENDORS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>

        {vendor === "OTHER" ? (
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-500">Vendor name</span>
            <input
              type="text"
              value={vendorLabel}
              onChange={(event) => setVendorLabel(event.target.value)}
              placeholder="Twilio"
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        ) : null}

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">Type</span>
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as CostKind)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="METERED">Caused by one project</option>
            <option value="BASE_FEE">Shared — split across clients</option>
          </select>
        </label>

        {kind === "METERED" ? (
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-neutral-500">Project</span>
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="">Choose…</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">What was it for</span>
          <input
            type="text"
            value={service}
            onChange={(event) => setService(event.target.value)}
            placeholder="Maps Platform — Geocoding"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">Cost (USD)</span>
          <input
            type="number"
            step="0.01"
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            placeholder="42.50"
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">
            Quantity (optional)
          </span>
          <div className="flex gap-1">
            <input
              type="number"
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
            />
            <input
              type="text"
              value={unit}
              onChange={(event) => setUnit(event.target.value)}
              placeholder="requests"
              className="w-28 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </div>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={submit}
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Adding…" : "Add cost"}
        </button>
        {message ? (
          <span
            className={`text-sm ${
              message.tone === "ok"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-red-600 dark:text-red-400"
            }`}
          >
            {message.text}
          </span>
        ) : null}
      </div>

      {/* Anything entered by hand has to be removable by hand — a collector will
          never clean it up, so without this a typo would be permanent. */}
      {manualLines.length > 0 ? (
        <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Entered by hand this month
          </h4>
          <ul className="mt-2 space-y-1">
            {manualLines.map((line) => (
              <li
                key={line.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-sm dark:border-neutral-800 dark:bg-neutral-950/40"
              >
                <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs font-medium dark:bg-neutral-800">
                  {line.vendorLabel ?? line.vendor}
                </span>
                <span>{line.service}</span>
                <span className="text-xs text-neutral-500">
                  {line.kind === "BASE_FEE" ? "shared" : (line.projectName ?? "unattributed")}
                </span>
                <span className="ml-auto tabular-nums font-medium">
                  {formatUsd(line.costUsd)}
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await deleteCostLine(line.id);
                      if (!result.ok) {
                        setMessage({ tone: "bad", text: result.error ?? "Could not delete" });
                      }
                      router.refresh();
                    })
                  }
                  className="text-neutral-400 transition hover:text-red-600 disabled:opacity-40"
                  aria-label={`Delete ${line.service}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanel({
  defaultMarkupBasisPoints,
  resendUsdPerEmail,
  currency,
}: {
  defaultMarkupBasisPoints: number;
  resendUsdPerEmail: number;
  currency: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [markup, setMarkup] = useState(String(defaultMarkupBasisPoints / 100));
  const [perEmail, setPerEmail] = useState(String(resendUsdPerEmail));
  const [code, setCode] = useState(currency);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">
            House markup (%)
          </span>
          <input
            type="number"
            step="0.5"
            min="0"
            value={markup}
            onChange={(event) => setMarkup(event.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Applies to every client without its own rate.
          </span>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">
            Resend $ per email
          </span>
          <input
            type="number"
            step="0.00001"
            min="0"
            value={perEmail}
            onChange={(event) => setPerEmail(event.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Leave at 0 to treat Resend as a plan fee and split it by client.
          </span>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-neutral-500">
            Billing currency
          </span>
          <input
            type="text"
            maxLength={3}
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-sm uppercase dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="mt-1 block text-xs text-neutral-400">
            Applies to periods whose rate has not been fetched yet.
          </span>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await updateBillingSettings({
                defaultMarkupBasisPoints: Math.round((Number.parseFloat(markup) || 0) * 100),
                resendUsdPerEmail: Number.parseFloat(perEmail) || 0,
                billingCurrency: code.trim().toUpperCase() || "ZAR",
              });
              setMessage("Settings saved.");
              router.refresh();
            })
          }
          className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          Save settings
        </button>
        {message ? <span className="text-sm text-neutral-500">{message}</span> : null}
      </div>
    </div>
  );
}
