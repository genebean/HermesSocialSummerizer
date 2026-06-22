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

export interface MastodonCard {
  url: string;
  title: string;
  description: string;
}

export interface MastodonPost {
  id: string;
  author: string;
  created_at: string;
  text: string;
  text_html: string;
  url: string | null;
  favourited: boolean;
  boosted: boolean;
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  language: string | null;
  mentions: string[];
  hashtags: string[];
  urls: string[];
  card: MastodonCard | null;
}

export interface MastodonReblog {
  id: string;
  reblogged_at: string;
  original_author: string;
  original_text: string;
  original_text_html: string;
  original_url: string | null;
  original_favourites_count: number;
  original_reblogs_count: number;
  original_replies_count: number;
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
      // statusText is empty on HTTP/2; try the JSON body's error field instead.
      let detail = resp.statusText.slice(0, 100).replace(/[\r\n]/g, "");
      try {
        const body = await resp.clone().json() as Record<string, unknown>;
        if (typeof body.error === "string") detail = body.error.slice(0, 200);
      } catch { /* non-JSON error body, fall through to statusText */ }
      throw new Error(`Mastodon ${path}: ${resp.status} ${detail}`.trimEnd());
    }
    return resp.json() as Promise<T>;
  }

  private async getMeId(): Promise<string> {
    if (this.meId) return this.meId;
    const me = await withRetry(() => this.get<{ id: string }>("/api/v1/accounts/verify_credentials"));
    this.meId = me.id;
    return this.meId;
  }

  async homeTimeline(limit = 40, sinceId?: string, maxPages = 1): Promise<MastodonPost[]> {
    const all: MastodonPost[] = [];
    let maxId: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params: Record<string, string | number> = { limit };
      if (sinceId) params.since_id = sinceId;
      if (maxId) params.max_id = maxId;
      const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/timelines/home", params));
      const posts = statuses.map(simplifyStatus);
      all.push(...posts);
      if (posts.length < limit) break;
      maxId = posts[posts.length - 1].id;
    }

    return all;
  }

  async favourites(limit = 40, maxId?: string): Promise<MastodonPost[]> {
    const params: Record<string, string | number> = { limit };
    if (maxId) params.max_id = maxId;
    const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/favourites", params));
    return statuses.map(simplifyStatus);
  }

  async bookmarks(limit = 40, maxId?: string): Promise<MastodonPost[]> {
    const params: Record<string, string | number> = { limit };
    if (maxId) params.max_id = maxId;
    const statuses = await withRetry(() => this.get<RawStatus[]>("/api/v1/bookmarks", params));
    return statuses.map(simplifyStatus);
  }

  async reblogs(limit = 40, maxId?: string): Promise<{ reblogs: MastodonReblog[]; next_max_id?: string }> {
    const id = await this.getMeId();
    // The /accounts/:id/statuses endpoint is capped at 40 per page by the API.
    // We filter for reblogs afterwards, so the reblog count per page may be less than `limit`.
    // next_max_id is the oldest status ID seen (not just reblogs), for use as max_id on the next call.
    const params: Record<string, string | number> = {
      limit: Math.min(limit, 40),
      exclude_reblogs: "false",
    };
    if (maxId) params.max_id = maxId;
    const statuses = await withRetry(() =>
      this.get<RawStatus[]>(`/api/v1/accounts/${id}/statuses`, params)
    );
    return {
      reblogs: statuses.filter((s) => s.reblog !== null).slice(0, limit).map(simplifyReblog),
      next_max_id: statuses.length > 0 ? statuses[statuses.length - 1].id : undefined,
    };
  }
}

interface RawAccount {
  acct: string;
}

interface RawMention {
  acct: string;
}

interface RawTag {
  name: string;
}

interface RawCard {
  url: string;
  title: string;
  description: string;
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
  favourites_count: number;
  reblogs_count: number;
  replies_count: number;
  language: string | null;
  mentions: RawMention[];
  tags: RawTag[];
  card: RawCard | null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractUrls(html: string): string[] {
  const urls: string[] = [];
  const anchorRe = /<a\s([^>]*)>/gi;
  const hrefRe = /href="([^"]+)"/i;
  const classRe = /class="[^"]*(?:mention|hashtag)[^"]*"/i;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1];
    if (classRe.test(attrs)) continue;
    const href = hrefRe.exec(attrs);
    if (href && href[1].startsWith("http")) urls.push(href[1]);
  }
  return [...new Set(urls)];
}

function simplifyStatus(s: RawStatus): MastodonPost {
  const src = s.reblog ?? s;
  return {
    id: s.id,
    author: s.reblog ? `${s.account.acct} ➔ ${s.reblog.account.acct}` : s.account.acct,
    created_at: s.created_at,
    text: stripHtml(src.content),
    text_html: src.content,
    url: src.url,
    favourited: Boolean(s.favourited),
    boosted: s.reblog !== null,
    favourites_count: src.favourites_count,
    reblogs_count: src.reblogs_count,
    replies_count: src.replies_count,
    language: src.language,
    mentions: src.mentions.map((m) => m.acct),
    hashtags: src.tags.map((t) => t.name),
    urls: extractUrls(src.content),
    card: src.card ? { url: src.card.url, title: src.card.title, description: src.card.description } : null,
  };
}

function simplifyReblog(s: RawStatus): MastodonReblog {
  const orig = s.reblog!;
  return {
    id: s.id,
    reblogged_at: s.created_at,
    original_author: orig.account.acct,
    original_text: stripHtml(orig.content),
    original_text_html: orig.content,
    original_url: orig.url,
    original_favourites_count: orig.favourites_count,
    original_reblogs_count: orig.reblogs_count,
    original_replies_count: orig.replies_count,
  };
}
