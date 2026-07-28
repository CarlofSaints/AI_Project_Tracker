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
    production?: { alias?: string[]; url?: string };
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
