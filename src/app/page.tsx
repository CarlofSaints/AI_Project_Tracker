import { prisma } from "@/lib/db";
import { ProjectGrid } from "@/components/project-grid";
import { StatCard } from "@/components/stat-card";
import { SyncButton } from "@/components/sync-button";

// Reads live from Postgres on every request — the sync job is the cache.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [projects, organizations, lastSync] = await Promise.all([
    prisma.project.findMany({
      where: { hidden: false },
      orderBy: [{ gitPushedAt: { sort: "desc", nulls: "last" } }, { name: "asc" }],
      include: {
        client: { select: { id: true, name: true } },
        endCustomer: { select: { id: true, name: true } },
        databases: { select: { id: true, kind: true, provider: true, name: true } },
        connections: { select: { id: true, label: true, detail: true } },
        domains: {
          select: { id: true, domain: true, verified: true, isVercelDomain: true },
          orderBy: { isVercelDomain: "asc" },
        },
        signals: { select: { id: true, capability: true, source: true, evidence: true } },
      },
    }),
    prisma.organization.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  // Client and Customer are roles held on a project, not types of org — so the
  // counts are distinct orgs appearing in each role, and one org can be in both.
  const clientIds = new Set(projects.map((p) => p.clientId).filter(Boolean));
  const customerIds = new Set(projects.map((p) => p.endCustomerId).filter(Boolean));

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {lastSync?.finishedAt
              ? `Last synced ${formatRelative(lastSync.finishedAt)} · ${lastSync.projectsSeen} projects seen`
              : "Never synced — run a sync to pull in your projects."}
          </p>
        </div>
        <SyncButton />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Projects"
          value={projects.length}
          hint="Across all scopes"
          accent="gradient"
        />
        <StatCard
          label="Clients"
          value={clientIds.size}
          hint="Companies you invoice"
          accent="brand"
        />
        <StatCard
          label="Customers"
          value={customerIds.size}
          hint="Companies the work was for"
          accent="brand2"
        />
      </div>

      <ProjectGrid projects={projects} organizations={organizations} />
    </div>
  );
}

function formatRelative(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
