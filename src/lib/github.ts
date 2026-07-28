/**
 * GitHub REST client.
 *
 * Vercel already tells us which repo a project is linked to, so GitHub's job
 * here is narrow but important:
 *   1. catch repos that were never deployed (Vercel can't see those at all)
 *   2. supply freshness — pushedAt is a far better "is this still alive?"
 *      signal than anything on the Vercel side
 *   3. read package.json so dependencies can feed capability detection
 */

const API = "https://api.github.com";

export interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  pushed_at: string | null;
  open_issues_count: number;
  default_branch: string;
  owner: { login: string; type: string }; // type: "User" | "Organization"
}

export class GitHubClient {
  constructor(private token: string) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(new URL(path, API), {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub ${res.status} on ${path}: ${body.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Every repo for an owner. Personal repos and org repos live on different
   * endpoints — `/user/repos` does NOT include org repos, which is the trap
   * that makes `gh repo list` look like it's missing things.
   */
  async repos(owner: string, isOrg: boolean): Promise<GitHubRepo[]> {
    const base = isOrg ? `/orgs/${owner}/repos` : `/users/${owner}/repos`;
    const out: GitHubRepo[] = [];

    for (let page = 1; page <= 10; page++) {
      const batch = await this.get<GitHubRepo[]>(
        `${base}?per_page=100&sort=pushed&page=${page}`,
      );
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  /** Dependency names from package.json, or [] if the repo has none. */
  async dependencies(owner: string, repo: string): Promise<string[]> {
    try {
      const file = await this.get<{ content?: string; encoding?: string }>(
        `/repos/${owner}/${repo}/contents/package.json`,
      );
      if (!file.content) return [];

      const json = JSON.parse(
        Buffer.from(file.content, (file.encoding as BufferEncoding) ?? "base64").toString("utf8"),
      );
      return [
        ...Object.keys(json.dependencies ?? {}),
        ...Object.keys(json.devDependencies ?? {}),
      ];
    } catch {
      // No package.json, private-repo permissions, or a non-JS project.
      return [];
    }
  }
}

/** Owners to sweep, from GITHUB_OWNERS="CarlofSaints:user,OuterJoinZA:org". */
export function configuredOwners(raw: string | undefined): Array<{ owner: string; isOrg: boolean }> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [owner, kind] = entry.split(":").map((s) => s.trim());
      return { owner, isOrg: (kind ?? "").toLowerCase().startsWith("org") };
    });
}
