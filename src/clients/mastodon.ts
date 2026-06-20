/**
 * Read-only Mastodon client using native fetch.
 * Only GET requests; no post/favourite/reblog method exists here.
 * Token must be scoped to "read" only at the OAuth app level.
 */

async function withRetry<T>(fn: () => Promise<T>, retries = 3, backoff = 100): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
    }
  }
  throw new Error("unreachable");
}

export interface MastodonPost {
  id: string;
  author: string;
  created_at: string;
  text: string;
  url: string | null;
  favourited: boolean;
  boosted: boolean;
}

export interface MastodonReblog {
  id: string;
  reblogged_at: string;
  original_author: string;
  original_text: string;
  original_url: string | null;
}

export class MastodonReadClient {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private meId?: string;

  constructor(instanceUrl: string, accessToken: string) {
    this.base = instanceUrl.replace(/\/$/, "");
    this.headers = { Authorization: `Bearer ${accessToken}` };
  }

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      const status = resp.statusText.slice(0, 100).replace(/[\r\n]/g, "");
      throw new Error(`Mastodon ${path}: ${resp.status} ${status}`);
    }
    return resp.json() as Promise<T>;
  }

  private async getMeId(): Promise<string> {
    if (this.meId) return this.meId;
    const me = await withRetry(() => this.get<{ id: string }>("/api/v1/accounts/verify_credentials"));
    this.meId = me.id;
    return this.meId;
  }

  async homeTimeline(limit = 40, sinceId?: string): Promise<MastodonPost[]> {
    const params: Record<string, string | number> = { limit };
    if (sinceId) params.since_id = sinceId;
    const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/timelines/home", params));
    return statuses.map(simplifyStatus);
  }

  async favourites(limit = 40): Promise<MastodonPost[]> {
    const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/favourites", { limit }));
    return statuses.map(simplifyStatus);
  }

  async bookmarks(limit = 40): Promise<MastodonPost[]> {
    const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/bookmarks", { limit }));
    return statuses.map(simplifyStatus);
  }

  async reblogs(limit = 40): Promise<MastodonReblog[]> {
    const id = await this.getMeId();
    const statuses = await withRetry(() =>
      this.get<RawStatus[]>(`/api/v1/accounts/${id}/statuses`, {
        limit: limit * 2,
        exclude_reblogs: "false",
      })
    );
    return statuses
      .filter((s) => s.reblog !== null)
      .slice(0, limit)
      .map(simplifyReblog);
  }
}

interface RawAccount {
  acct: string;
}

interface RawStatus {
  id: string;
  account: RawAccount;
  content: string;
  created_at: string;
  url: string | null;
  favourited: boolean | null;
  reblogged: boolean | null;
  reblog: RawStatus | null;
}

function simplifyStatus(s: RawStatus): MastodonPost {
  const src = s.reblog ?? s;
  return {
    id: s.id,
    author: s.reblog ? `${s.account.acct} ➔ ${s.reblog.account.acct}` : s.account.acct,
    created_at: s.created_at,
    text: src.content,
    url: src.url,
    favourited: Boolean(s.favourited),
    boosted: s.reblog !== null,
  };
}

function simplifyReblog(s: RawStatus): MastodonReblog {
  const orig = s.reblog!;
  return {
    id: s.id,
    reblogged_at: s.created_at,
    original_author: orig.account.acct,
    original_text: orig.content,
    original_url: orig.url,
  };
}
