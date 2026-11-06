"use client";

import { useRef, useState, useTransition } from "react";
import { connectAnalytics } from "@/app/analytics/actions";

const FIELD =
  "rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

export function AnalyticsAddSite({ projects }: { projects: { id: string; name: string }[] }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  // onSubmit, not a form action: React resets a form after its action runs, which
  // would wipe what was typed when the ID is refused.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await connectAnalytics(String(data.get("projectId")), String(data.get("propertyId")));
      if (result.ok) formRef.current?.reset();
      else setError(result.error ?? "Could not add the project.");
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900"
    >
      <h2 className="text-sm font-semibold">Add a project</h2>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Project
          <select name="projectId" required defaultValue="" className={`${FIELD} min-w-64`}>
            <option value="" disabled>
              Choose a project
            </option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Google Analytics Property ID
          <input name="propertyId" required inputMode="numeric" placeholder="e.g. 412345678" className={FIELD} />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Adding..." : "Add project"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
