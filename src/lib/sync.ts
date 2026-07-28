/**
 * The sync engine.
 *
 * Sweeps every configured Vercel scope and GitHub owner, then writes a snapshot
 * into our own Postgres. The dashboard reads only from Postgres — we never call
 * these APIs on page load, because a single project needs ~3 Vercel calls and
 * the grid would be dozens of round trips deep before it rendered anything.
 *
 * THE ONE RULE: this never overwrites a field a human owns. Client, end
 * customer, stage, notes, display name and the capability overrides all survive
 * every sync. Only the columns listed in `syncOwned` below get written.
 */

import { prisma } from "@/lib/db";
import { GitHubClient, configuredOwners, type GitHubRepo } from "@/lib/github";
import { VercelClient, productionUrl, type VercelProject } from "@/lib/vercel";
import {
  connectionsFromEnvKeys,
  rollUp,
  signalsFromDependencies,
  signalsFromEnvKeys,
  storesFromEnvKeys,
  type Signal,
} from "@/lib/detect";

export interface SyncResult {
  projectsSeen: number;
  created: number;
  updated: number;
  log: string[];
}

interface Candidate {
  vercelProjectId: string | null;
  vercelProjectName: string | null;
  vercelScopeSlug: string | null;
  vercelScopeName: string | null;
  productionUrl: string | null;
  gitOwner: string | null;
  gitOwnerType: "USER" | "ORGANIZATION" | null;
  gitRepo: string | null;
  gitUrl: string | null;
  gitPrivate: boolean | null;
  gitPushedAt: Date | null;
  gitOpenIssues: number | null;
  envKeys: Array<{ key: string; targets: string[]; isSensitive: boolean }>;
  domains: Array<{ domain: string; verified: boolean; isVercelDomain: boolean; redirectTo: string | null }>;
  deps: string[];
}

export async function runSync(): Promise<SyncResult> {
  const log: string[] = [];
  const vercelToken = process.env.VERCEL_TOKEN;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!vercelToken && !githubToken) {
    throw new Error("Neither VERCEL_TOKEN nor GITHUB_TOKEN is set — nothing to sync.");
  }

  // Keyed by "owner/repo" when we know the repo, else "vercel:<id>".
  const candidates = new Map<string, Candidate>();

  // ---------------------------------------------------------- Vercel
  if (vercelToken) {
    const vercel = new VercelClient(vercelToken);
    const scopes: Array<{ id?: string; slug: string; name: string }> = [
      { slug: "personal", name: "Personal" }, // no teamId — the user's own scope
    ];

    try {
      for (const team of await vercel.teams()) {
        scopes.push({ id: team.id, slug: team.slug, name: team.name });
      }
    } catch (err) {
      log.push(`Could not list Vercel teams: ${message(err)}`);
    }

    for (const scope of scopes) {
      let projects: VercelProject[] = [];
      try {
        projects = await vercel.projects(scope.id);
      } catch (err) {
        log.push(`Scope ${scope.slug}: ${message(err)}`);
        continue;
      }
      log.push(`Vercel scope ${scope.slug}: ${projects.length} projects`);

      for (const project of projects) {
        const envKeys = await safe(
          () => vercel.envVars(project.id, scope.id),
          [],
          log,
          `env vars for ${project.name}`,
        );
        const domains = await safe(
          () => vercel.domains(project.id, scope.id),
          [],
          log,
          `domains for ${project.name}`,
        );

        const owner = project.link?.org ?? null;
        const repo = project.link?.repo ?? null;
        const key = owner && repo ? `${owner}/${repo}`.toLowerCase() : `vercel:${project.id}`;

        candidates.set(key, {
          vercelProjectId: project.id,
          vercelProjectName: project.name,
          vercelScopeSlug: scope.slug,
          vercelScopeName: scope.name,
          productionUrl: productionUrl(project),
          gitOwner: owner,
          gitOwnerType: null, // filled in from GitHub, which actually knows
          gitRepo: repo,
          gitUrl: owner && repo ? `https://github.com/${owner}/${repo}` : null,
          gitPrivate: null,
          gitPushedAt: null,
          gitOpenIssues: null,
          envKeys: envKeys.map((e) => ({
            key: e.key,
            targets: e.target ?? [],
            isSensitive: e.type === "sensitive",
          })),
          domains: domains.map((d) => ({
            domain: d.name,
            verified: Boolean(d.verified),
            isVercelDomain: d.name.endsWith(".vercel.app"),
            redirectTo: d.redirect ?? null,
          })),
          deps: [],
        });
      }
    }
  }

  // ---------------------------------------------------------- GitHub
  if (githubToken) {
    const github = new GitHubClient(githubToken);
    const owners = configuredOwners(process.env.GITHUB_OWNERS);

    for (const { owner, isOrg } of owners) {
      let repos: GitHubRepo[] = [];
      try {
        repos = await github.repos(owner, isOrg);
      } catch (err) {
        log.push(`GitHub ${owner}: ${message(err)}`);
        continue;
      }
      log.push(`GitHub ${owner}: ${repos.length} repos`);

      for (const repo of repos) {
        const key = `${repo.owner.login}/${repo.name}`.toLowerCase();
        const existing = candidates.get(key);

        const gitFields = {
          gitOwner: repo.owner.login,
          gitOwnerType: (repo.owner.type === "Organization" ? "ORGANIZATION" : "USER") as
            | "ORGANIZATION"
            | "USER",
          gitRepo: repo.name,
          gitUrl: repo.html_url,
          gitPrivate: repo.private,
          gitPushedAt: repo.pushed_at ? new Date(repo.pushed_at) : null,
          gitOpenIssues: repo.open_issues_count,
        };

        if (existing) {
          Object.assign(existing, gitFields);
        } else {
          // Never deployed to Vercel — still belongs in the inventory.
          candidates.set(key, {
            vercelProjectId: null,
            vercelProjectName: null,
            vercelScopeSlug: null,
            vercelScopeName: null,
            productionUrl: null,
            ...gitFields,
            envKeys: [],
            domains: [],
            deps: [],
          });
        }
      }
    }

    // package.json drives dependency-based detection. One call per repo; well
    // inside GitHub's 5,000/hour authenticated limit at this scale.
    for (const candidate of candidates.values()) {
      if (!candidate.gitOwner || !candidate.gitRepo) continue;
      candidate.deps = await github.dependencies(candidate.gitOwner, candidate.gitRepo);
    }
  }

  // ---------------------------------------------------------- persist
  let created = 0;
  let updated = 0;

  for (const candidate of candidates.values()) {
    const wasCreated = await persist(candidate);
    if (wasCreated) created++;
    else updated++;
  }

  return { projectsSeen: candidates.size, created, updated, log };
}

/** Returns true if a new project row was created. */
async function persist(c: Candidate): Promise<boolean> {
  const envKeyNames = c.envKeys.map((e) => e.key);
  const signals: Signal[] = [
    ...signalsFromEnvKeys(envKeyNames),
    ...signalsFromDependencies(c.deps),
  ];
  const flags = rollUp(signals);
  const stores = storesFromEnvKeys(envKeyNames);
  const connections = connectionsFromEnvKeys(envKeyNames);

  // Match on Vercel id first, then on the repo — so a repo-only row created by
  // an earlier GitHub-only sync gets upgraded rather than duplicated.
  const existing =
    (c.vercelProjectId
      ? await prisma.project.findUnique({ where: { vercelProjectId: c.vercelProjectId } })
      : null) ??
    (c.gitOwner && c.gitRepo
      ? await prisma.project.findFirst({ where: { gitOwner: c.gitOwner, gitRepo: c.gitRepo } })
      : null);

  // Sync-owned columns only. Everything a human touches is absent by design.
  const syncOwned = {
    vercelProjectId: c.vercelProjectId,
    vercelProjectName: c.vercelProjectName,
    vercelScopeSlug: c.vercelScopeSlug,
    vercelScopeName: c.vercelScopeName,
    productionUrl: c.productionUrl,
    gitOwner: c.gitOwner,
    gitOwnerType: c.gitOwnerType,
    gitRepo: c.gitRepo,
    gitUrl: c.gitUrl,
    gitPrivate: c.gitPrivate,
    gitPushedAt: c.gitPushedAt,
    gitOpenIssues: c.gitOpenIssues,
    envVarCount: c.envKeys.length,
    domainCount: c.domains.length,
    databaseCount: stores.length,
    ...flags,
    lastSyncedAt: new Date(),
  };

  const project = existing
    ? await prisma.project.update({ where: { id: existing.id }, data: syncOwned })
    : await prisma.project.create({
        data: {
          ...syncOwned,
          // Display name is set once, then owned by Carl.
          name: c.vercelProjectName ?? c.gitRepo ?? "Untitled project",
        },
      });

  // Children are a full replace — they're pure projections of the APIs.
  await prisma.$transaction([
    prisma.projectEnvVar.deleteMany({ where: { projectId: project.id } }),
    prisma.projectDomain.deleteMany({ where: { projectId: project.id } }),
    prisma.projectDatabase.deleteMany({ where: { projectId: project.id } }),
    prisma.externalConnection.deleteMany({ where: { projectId: project.id, inferred: true } }),
    prisma.detectionSignal.deleteMany({ where: { projectId: project.id, source: { not: "MANUAL" } } }),

    prisma.projectEnvVar.createMany({
      data: c.envKeys.map((e) => ({ projectId: project.id, ...e })),
      skipDuplicates: true,
    }),
    prisma.projectDomain.createMany({
      data: c.domains.map((d) => ({ projectId: project.id, ...d })),
      skipDuplicates: true,
    }),
    prisma.projectDatabase.createMany({
      data: stores.map((s) => ({ projectId: project.id, ...s, inferred: true })),
      skipDuplicates: true,
    }),
    prisma.externalConnection.createMany({
      data: connections.map((x) => ({ projectId: project.id, ...x, inferred: true })),
      skipDuplicates: true,
    }),
    prisma.detectionSignal.createMany({
      data: signals.map((s) => ({ projectId: project.id, ...s })),
      skipDuplicates: true,
    }),
  ]);

  return !existing;
}

async function safe<T>(fn: () => Promise<T>, fallback: T, log: string[], what: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.push(`Skipped ${what}: ${message(err)}`);
    return fallback;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
