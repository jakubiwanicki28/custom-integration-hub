import type { Logger } from 'pino';
import { fetchWithTimeout, safeJson } from './fetch.js';

// --- Types ---

export interface GitHubCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface CompareResult {
  totalCommits: number;
  commits: GitHubCommit[];
  stats: { additions: number; deletions: number };
}

interface GitHubCompareResponse {
  total_commits: number;
  commits: Array<{
    sha: string;
    commit: {
      message: string;
      author: { name: string; date: string };
    };
    author?: { login: string } | null;
  }>;
  files?: Array<{
    additions: number;
    deletions: number;
  }>;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
}

interface GitHubCommitResponse {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string };
  };
  author?: { login: string } | null;
}

// --- Factory ---

export function createGitHubClient(token: string, owner: string, repo: string, log: Logger) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

  function mapCommit(c: GitHubCompareResponse['commits'][0]): GitHubCommit {
    return {
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0], // first line only
      author: c.author?.login ?? c.commit.author.name,
      date: c.commit.author.date,
    };
  }

  async function compareCommits(base: string, head: string): Promise<CompareResult | null> {
    const url = `${baseUrl}/compare/${base}...${head}`;

    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers });

      if (!res.ok) {
        log.error({ status: res.status, base, head }, 'GitHub compare API error');
        return null;
      }

      const data = await safeJson<GitHubCompareResponse>(res);

      const stats = { additions: 0, deletions: 0 };
      if (data.files) {
        for (const f of data.files) {
          stats.additions += f.additions;
          stats.deletions += f.deletions;
        }
      }

      return {
        totalCommits: data.total_commits,
        commits: data.commits.map(mapCommit),
        stats,
      };
    } catch (err) {
      log.error({ err, base, head }, 'GitHub compareCommits failed');
      return null;
    }
  }

  async function getRecentCommits(branch: string, count = 10): Promise<GitHubCommit[]> {
    const url = `${baseUrl}/commits?sha=${encodeURIComponent(branch)}&per_page=${count}`;

    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers });

      if (!res.ok) {
        log.error({ status: res.status, branch }, 'GitHub commits API error');
        return [];
      }

      const data = await safeJson<GitHubCommitResponse[]>(res);

      return data.map(c => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split('\n')[0],
        author: c.author?.login ?? c.commit.author.name,
        date: c.commit.author.date,
      }));
    } catch (err) {
      log.error({ err, branch }, 'GitHub getRecentCommits failed');
      return [];
    }
  }

  async function createPullRequest(
    title: string, body: string, head: string, base: string,
  ): Promise<GitHubPullRequest | null> {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/pulls`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, head, base }),
      });

      if (res.status === 422) {
        const errBody = await safeJson<{ message?: string; errors?: Array<{ message?: string }> }>(res);
        log.warn({ head, base, message: errBody.message, errors: errBody.errors }, 'GitHub PR creation 422');
        return null;
      }

      if (!res.ok) {
        log.error({ status: res.status, head, base }, 'GitHub create PR API error');
        return null;
      }

      return await safeJson<GitHubPullRequest>(res);
    } catch (err) {
      log.error({ err, head, base }, 'GitHub createPullRequest failed');
      return null;
    }
  }

  async function listOpenPullRequests(head: string, base: string): Promise<GitHubPullRequest[]> {
    const url = `${baseUrl}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`;

    try {
      const res = await fetchWithTimeout(url, { method: 'GET', headers });

      if (!res.ok) {
        log.error({ status: res.status, head, base }, 'GitHub list PRs API error');
        return [];
      }

      return await safeJson<GitHubPullRequest[]>(res);
    } catch (err) {
      log.error({ err, head, base }, 'GitHub listOpenPullRequests failed');
      return [];
    }
  }

  return { compareCommits, getRecentCommits, createPullRequest, listOpenPullRequests };
}
