"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOrganization, deleteOrganization, updateOrganization } from "@/app/actions";

export interface ManagedOrg {
  id: string;
  name: string;
  notes: string | null;
  website: string | null;
  parent: { id: string; name: string } | null;
  _count: { projectsAsClient: number; projectsAsEndCustomer: number };
}

type OrgPatch = {
  name?: string;
  notes?: string | null;
  website?: string | null;
  parentId?: string | null;
};

export function OrganizationManager({ organizations }: { organizations: ManagedOrg[] }) {
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
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

  function beginEdit(id: string) {
    setError(null);
    setEditError(null);
    setEditingId(id);
  }

  function onSaveEdit(id: string, patch: OrgPatch) {
    setEditError(null);
    startTransition(async () => {
      const result = await updateOrganization(id, patch);
      if (result.ok) {
        setEditingId(null);
        router.refresh();
      } else {
        setEditError(result.error ?? "Could not save changes");
      }
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
            className="w-64 rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Usually sits under (optional)
          </span>
          <select
            name="parentId"
            className="w-64 rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
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
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"
        >
          Add organisation
        </button>

        <p className="w-full text-xs text-neutral-400 dark:text-neutral-500">
          “Sits under” only pre-fills the project form. It never stops this organisation being a
          client in its own right. Everything here stays editable afterwards, spelling included.
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
              <th className="w-28 px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {organizations.map((org) =>
              editingId === org.id ? (
                <tr
                  key={org.id}
                  className="border-b border-neutral-100 bg-neutral-50 last:border-0 dark:border-neutral-800/60 dark:bg-neutral-800/40"
                >
                  <td colSpan={6} className="px-4 py-4">
                    <OrgEditForm
                      key={org.id}
                      org={org}
                      organizations={organizations}
                      pending={pending}
                      error={editError}
                      onCancel={() => setEditingId(null)}
                      onSave={(patch) => onSaveEdit(org.id, patch)}
                    />
                  </td>
                </tr>
              ) : (
                <tr
                  key={org.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{org.name}</div>
                    {org.website ? (
                      <a
                        href={websiteHref(org.website)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-neutral-500 underline-offset-2 hover:text-[var(--brand-text)] hover:underline dark:text-neutral-400"
                      >
                        {org.website}
                      </a>
                    ) : null}
                    {org.notes ? (
                      <div className="mt-0.5 max-w-md truncate text-xs text-neutral-400 dark:text-neutral-500">
                        {org.notes}
                      </div>
                    ) : null}
                  </td>
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
                    <div className="flex justify-end gap-3">
                      <button
                        onClick={() => beginEdit(org.id)}
                        disabled={pending}
                        className="text-xs text-neutral-400 transition hover:text-[var(--brand-text)] disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => onDelete(org.id, org.name)}
                        disabled={pending}
                        className="text-xs text-neutral-400 transition hover:text-red-600 disabled:opacity-50 dark:hover:text-red-400"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
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

/**
 * Declared at module level on purpose. A component defined inside another one
 * is a brand-new type on every render, so React remounts it and the field being
 * typed into loses focus after every keystroke.
 */
function OrgEditForm({
  org,
  organizations,
  pending,
  error,
  onCancel,
  onSave,
}: {
  org: ManagedOrg;
  organizations: ManagedOrg[];
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (patch: OrgPatch) => void;
}) {
  const [name, setName] = useState(org.name);
  const [parentId, setParentId] = useState(org.parent?.id ?? "");
  const [website, setWebsite] = useState(org.website ?? "");
  const [notes, setNotes] = useState(org.notes ?? "");

  // An organisation can't sit under itself or under one of its own children.
  // Offering those options would only earn a rejection after the round trip.
  const blocked = descendantIds(organizations, org.id);
  const parentOptions = organizations.filter((o) => o.id !== org.id && !blocked.has(o.id));

  function submit(event: React.FormEvent) {
    event.preventDefault();
    // Every editable field is sent, so nothing is silently left on an old value.
    onSave({ name, parentId: parentId || null, website, notes });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Organisation name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            className="w-64 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Usually sits under
          </span>
          <select
            value={parentId}
            onChange={(e) => setParentId(e.target.value)}
            className="w-64 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
          >
            <option value="">— none —</option>
            {parentOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Website (optional)
          </span>
          <input
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="atomicmarketing.co.za"
            className="w-64 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
          Notes (optional)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          placeholder="Who the contact is, how they are invoiced, anything worth remembering."
          className="w-full max-w-3xl rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-[var(--brand)] focus:ring-1 focus:ring-[var(--brand)] dark:border-neutral-700 dark:bg-neutral-800"
        />
      </label>

      {error ? (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium transition hover:border-neutral-400 disabled:opacity-50 dark:border-neutral-700"
        >
          Cancel
        </button>
        <span className="text-xs text-neutral-400 dark:text-neutral-500">
          A rename follows through to every project pointing at this organisation. Which projects it
          is the client or the customer on is still set per project, on the dashboard.
        </span>
      </div>
    </form>
  );
}

/** Every organisation sitting somewhere beneath `rootId`, however deep. */
function descendantIds(orgs: ManagedOrg[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const org of orgs) {
    if (!org.parent) continue;
    const siblings = childrenOf.get(org.parent.id) ?? [];
    siblings.push(org.id);
    childrenOf.set(org.parent.id, siblings);
  }

  const found = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const child of childrenOf.get(current) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}

/** Websites are typed by hand, so most arrive without a scheme. */
function websiteHref(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

function RoleBadges({ asClient, asCustomer }: { asClient: number; asCustomer: number }) {
  if (asClient === 0 && asCustomer === 0) {
    return <span className="text-xs text-neutral-400">Unassigned</span>;
  }
  return (
    <div className="flex gap-1">
      {/* One accent each, used consistently across the app: magenta means
          client, cyan means customer. A company doing both shows both. */}
      {asClient > 0 ? (
        <span className="rounded bg-[var(--brand-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--brand-text)]">
          Client
        </span>
      ) : null}
      {asCustomer > 0 ? (
        <span className="rounded bg-[var(--brand-2-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--brand-2-text)]">
          Customer
        </span>
      ) : null}
    </div>
  );
}
