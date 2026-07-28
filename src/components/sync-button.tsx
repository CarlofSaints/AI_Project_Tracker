"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { triggerSync } from "@/app/actions";

export function SyncButton() {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();

  function onClick() {
    setMessage(null);
    startTransition(async () => {
      const result = await triggerSync();
      if (result.ok) {
        setMessage(`${result.created} new, ${result.updated} updated`);
        router.refresh();
      } else {
        setMessage(result.error ?? "Sync failed");
      }
    });
  }

  return (
    <div className="flex items-center gap-3">
      {message ? (
        <span className="max-w-xs truncate text-xs text-neutral-500 dark:text-neutral-400">
          {message}
        </span>
      ) : null}
      <button
        onClick={onClick}
        disabled={pending}
        className="rounded-lg bg-[var(--brand)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-85 disabled:opacity-50"
      >
        {pending ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}
