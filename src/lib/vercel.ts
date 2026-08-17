/**
 * Vercel REST client — the spine of the inventory.
 *
 * One token can see multiple scopes (teams). Everything below takes an explicit
 * teamId so we can sweep both of Carl's scopes with the same credentials.
 */

const API = "https://api.vercel.com";

export interface VercelTeam {
  id: string;
  slug: string;
  name: string;
}

export interface VercelProject {
  id: string;
  name: string;
  link?: {
    type?: string; // "github" | "gitlab" | "bitbucket"
    org?: string;
    repo?: string;
    repoId?: number;
    productionBranch?: string;
  };
  targets?: {
    production?: { alias?: string[]; url?: string; createdAt?: number; readyAt?: number };
  };
  updatedAt?: number;
}

export interface VercelEnvVar {
  key: string;
  target?: string[];
  type?: string; // "encrypted" | "sensitive" | "plain" | "system"
}

export interface VercelDomain {
  name: string;
  verified?: boolean;
  redirect?: string | null;
}

export interface VercelStore {
  id: string;
  name: string;
  type: string; // "blob" | "postgres" | "redis" | "integration" ...
  integrationSlug?: string;
  projectIds?: string[];
}

export class VercelClient {
  constructor(private token: string) {}

  private async get<T>(path: string, teamId?: string): Promise<T> {
    const url = new URL(path, API);
    if (teamId) url.searchParams.set("teamId", teamId);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      // Always hit Vercel fresh; our own DB is the cache.
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Vercel ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  /** Scopes this token can see. The personal scope has no team id. */
  async teams(): Promise<VercelTeam[]> {
    const data = await this.get<{ teams: VercelTeam[] }>("/v2/teams");
    return data.teams ?? [];
  }

  async projects(teamId?: string): Promise<VercelProject[]> {
    const out: VercelProject[] = [];
    let until: number | undefined;

    // /v9/projects pages backwards through time via `until`.
    for (let page = 0; page < 20; page++) {
      const path = `/v9/projects?limit=100${until ? `&until=${until}` : ""}`;
      const data = await this.get<{
        projects: VercelProject[];
        pagination?: { next: number | null };
      }>(path, teamId);

      out.push(...(data.projects ?? []));
      const next = data.pagination?.next;
      if (!next) break;
      until = next;
    }
    return out;
  }

  /** Env var KEYS. decrypt is never requested — we do not want the values. */
  async envVars(projectId: string, teamId?: string): Promise<VercelEnvVar[]> {
    const data = await this.get<{ envs: VercelEnvVar[] }>(
      `/v10/projects/${projectId}/env`,
      teamId,
    );
    return data.envs ?? [];
  }

  async domains(projectId: string, teamId?: string): Promise<VercelDomain[]> {
    const data = await this.get<{ domains: VercelDomain[] }>(
      `/v9/projects/${projectId}/domains?limit=100`,
      teamId,
    );
    return data.domains ?? [];
  }

  /**
   * FOCUS v1.3 billing charges for a scope, as newline-delimited JSON.
   *
   * This is the one Vercel endpoint that ties spend to a project: every row
   * carries the project id and name in its `Tags` object, so a charge can be
   * attributed without any mapping table of our own.
   *
   * Returned as raw text rather than parsed — the response is JSONL, not JSON,
   * and `res.json()` would choke on the second line. It also needs a token with
   * a billing-capable role on the team, so a 403 here is a permissions problem
   * rather than a bad request.
   */
  async billingChargesJsonl(from: Date, to: Date, teamId?: string): Promise<string> {
    const url = new URL("/v1/billing/charges", API);
    url.searchParams.set("from", from.toISOString());
    url.searchParams.set("to", to.toISOString());
    if (teamId) url.searchParams.set("teamId", teamId);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Vercel ${res.status} on /v1/billing/charges: ${body.slice(0, 300)}`,
      );
    }
    return res.text();
  }

  /**
   * Marketplace + first-party stores for a scope.
   *
   * This endpoint is less stable than the rest of the API and the shape of
   * project linkage varies by store type, so a failure here is non-fatal — the
   * sync falls back to inferring storage from env var keys, which catches
   * anything connected outside the marketplace anyway.
   */
  async stores(teamId?: string): Promise<VercelStore[]> {
    try {
      const data = await this.get<{ stores: VercelStore[] }>(
        "/v1/storage/stores?limit=100",
        teamId,
      );
      return data.stores ?? [];
    } catch {
      return [];
    }
  }
}

/** Production hostname for a project, preferring a custom domain. */
export function productionUrl(project: VercelProject): string | null {
  const aliases = project.targets?.production?.alias ?? [];
  const custom = aliases.find((a) => !a.endsWith(".vercel.app"));
  return custom ?? aliases[0] ?? project.targets?.production?.url ?? null;
}

/**
 * When the project last shipped to production. Prefers `readyAt` (the moment the
 * deployment went live) over `createdAt` (when the build was kicked off), and is
 * null for a project that has never had a production deployment.
 */
export function lastDeployedAt(project: VercelProject): Date | null {
  const prod = project.targets?.production;
  const ts = prod?.readyAt ?? prod?.createdAt;
  return ts ? new Date(ts) : null;
}
