"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOrganization, deleteOrganization } from "@/app/actions";

export interface ManagedOrg {
  id: string;
  name: string;
  notes: string | null;
  website: string | null;
  parent: { id: string; name: string } | null;
  _count: { projectsAsClient: number; projectsAsEndCustomer: number };
}

export function OrganizationManager({ organizations }: { organizations: ManagedOrg[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  function onCreate(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await createOrganization(formData);
      if (result.ok) {
        formRef.current?.reset();
        router.refresh();
      } else {
        setError(result.error ?? "Could not create organisation");
      }
    });
  }

  function onDelete(id: string, name: string) {
    setError(null);
    startTransition(async () => {
      const result = await deleteOrganization(id);
      if (result.ok) router.refresh();
      else setError(`${name}: ${result.error}`);
    });
  }

  return (
    <div className="space-y-6">
      <form
        ref={formRef}
        action={onCreate}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Organisation name
          </span>
          <input
            name="name"
            required
            placeholder="Atomic Marketing"
            className="w-64 rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800 dark:focus:border-neutral-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Usually sits under (optional)
          </span>
          <select
            name="parentId"
            className="w-64 rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">— none —</option>
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Add organisation
        </button>

        <p className="w-full text-xs text-neutral-400 dark:text-neutral-500">
          “Sits under” only pre-fills the project form. It never stops this organisation being a
          client in its own right.
        </p>
      </form>

      {error ? (
        <div className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-left text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <th className="px-4 py-3 font-medium">Organisation</th>
              <th className="px-4 py-3 font-medium">Sits under</th>
              <th className="px-4 py-3 text-right font-medium">As client</th>
              <th className="px-4 py-3 text-right font-medium">As customer</th>
              <th className="px-4 py-3 font-medium">Role</th>
              <th className="w-20 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) => (
              <tr
                key={org.id}
                className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
              >
                <td className="px-4 py-3 font-medium">{org.name}</td>
                <td className="px-4 py-3 text-neutral-500 dark:text-neutral-400">
                  {org.parent?.name ?? "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {org._count.projectsAsClient || "—"}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {org._count.projectsAsEndCustomer || "—"}
                </td>
                <td className="px-4 py-3">
                  <RoleBadges
                    asClient={org._count.projectsAsClient}
                    asCustomer={org._count.projectsAsEndCustomer}
                  />
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => onDelete(org.id, org.name)}
                    disabled={pending}
                    className="text-xs text-neutral-400 transition hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {organizations.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-12 text-center text-sm text-neutral-500 dark:text-neutral-400"
                >
                  No organisations yet — add your first one above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RoleBadges({ asClient, asCustomer }: { asClient: number; asCustomer: number }) {
  if (asClient === 0 && asCustomer === 0) {
    return <span className="text-xs text-neutral-400">Unassigned</span>;
  }
  return (
    <div className="flex gap-1">
      {asClient > 0 ? (
        <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-900 dark:bg-sky-500/15 dark:text-sky-300">
          Client
        </span>
      ) : null}
      {asCustomer > 0 ? (
        <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-900 dark:bg-violet-500/15 dark:text-violet-300">
          Customer
        </span>
      ) : null}
    </div>
  );
}
