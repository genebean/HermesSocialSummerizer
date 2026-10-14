/**
 * Read-only Bluesky client using @atproto/api.
 * Only read methods are called: getTimeline, getActorLikes, getAuthorFeed,
 * getFollows, getProfile. No post/like/repost/follow method exists here.
 *
 * Authenticated mode: app_password supplied → uses real session with auto token refresh.
 * Public mode: no app_password → reads via public AppView (no credentials stored).
 *
 * App passwords are NOT scope-limited on Bluesky, so store them in a dedicated,
 * revocable app password separate from your main login.
 */
import { AtpAgent } from "@atproto/api";

const PUBLIC_SERVICE = "https://public.api.bsky.app";
const AUTH_SERVICE = "https://bsky.social";

export interface BlueskyPost {
  uri: string;
  url: string;
  author: string;
  created_at: string;
  text: string;
  likes: number;
  repost_count: number;
  reply_count: number;
  quote_count: number;
  urls: string[];
  hashtags: string[];
  // Unset when standalone. Both present on a reply - the AT Protocol
  // record always carries its own immediate parent and the thread root,
  // unlike Mastodon which has no separate "root" concept.
  reply_parent_uri?: string;
  reply_root_uri?: string;
}

interface BlueskyFacetFeature {
  $type: string;
  uri?: string;
  tag?: string;
}

interface BlueskyRecord {
  createdAt?: string;
  text?: string;
  facets?: Array<{
    features: BlueskyFacetFeature[];
  }>;
  reply?: {
    root?: { uri?: string };
    parent?: { uri?: string };
  };
}

export class BlueskyReadClient {
  private readonly agent: AtpAgent;
  private readonly handle: string;
  private readonly appPassword?: string;
  private loginPromise?: Promise<void>;
  private did?: string;
  readonly authenticated: boolean;

  constructor(handle: string, appPassword?: string) {
    this.handle = handle;
    this.appPassword = appPassword;
    this.authenticated = Boolean(appPassword);
    this.agent = new AtpAgent({ service: appPassword ? AUTH_SERVICE : PUBLIC_SERVICE });
  }

  private ensureAuth(): Promise<void> {
    if (!this.authenticated) return Promise.resolve();
    if (!this.loginPromise) {
      this.loginPromise = this.agent
        .login({ identifier: this.handle, password: this.appPassword! })
        .then(() => undefined)
        .catch((e) => {
          this.loginPromise = undefined; // allow retry on next call
          throw e;
        });
    }
    return this.loginPromise;
  }

  async timeline(limit = 40, since?: string, maxPages = 1): Promise<BlueskyPost[]> {
    const all: BlueskyPost[] = [];

    if (this.authenticated) {
      await this.ensureAuth();
      let atCursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const resp = await this.agent.getTimeline({ limit, cursor: atCursor });
        const pagePosts = resp.data.feed.map((item) => simplifyPost(item.post));
        all.push(...pagePosts);
        atCursor = resp.data.cursor;
        if (!atCursor || pagePosts.length === 0) break;
        // Stop early once the oldest post on this page predates our cursor.
        if (since && pagePosts[pagePosts.length - 1].created_at <= since) break;
      }
    } else {
      // Public mode has no AT Protocol cursor; single fetch only.
      const fetchLimit = since ? Math.min(limit * 2, 100) : limit;
      all.push(...await this.publicFollowingFeed(fetchLimit));
    }

    const posts = since ? all.filter((p) => p.created_at > since) : all;
    return posts;
  }

  async likes(limit = 40, cursor?: string): Promise<{ posts: BlueskyPost[]; cursor?: string }> {
    await this.ensureAuth();
    const did = await this.resolveDid();
    const resp = await this.agent.app.bsky.feed.getActorLikes({ actor: did, limit, cursor });
    return {
      posts: resp.data.feed.map((item) => simplifyPost(item.post)),
      cursor: resp.data.cursor,
    };
  }

  async reposts(limit = 40, cursor?: string): Promise<{ posts: BlueskyPost[]; cursor?: string }> {
    await this.ensureAuth();
    const did = await this.resolveDid();
    // getAuthorFeed returns all post types; we filter for repost reasons.
    // Each page may contain few or no reposts depending on posting frequency.
    const resp = await this.agent.app.bsky.feed.getAuthorFeed({
      actor: did,
      limit: Math.min(limit * 3, 100),
      cursor,
    });
    return {
      posts: resp.data.feed
        .filter((item) => item.reason?.$type === "app.bsky.feed.defs#reasonRepost")
        .slice(0, limit)
        .map((item) => simplifyPost(item.post)),
      cursor: resp.data.cursor,
    };
  }

  // Point lookup by URI, not an account's feed - works identically in
  // public mode, no login needed, same as nostr_get_event's role for
  // Nostr. depth/parentHeight bound how far the AT Protocol server itself
  // walks the tree; this just flattens what comes back.
  async postThread(uri: string, depth = 6, parentHeight = 10): Promise<{ ancestors: BlueskyPost[]; descendants: BlueskyPost[] }> {
    const resp = await this.agent.app.bsky.feed.getPostThread({ uri, depth, parentHeight });
    const thread = resp.data.thread;
    if (!isThreadViewPost(thread)) return { ancestors: [], descendants: [] };

    const ancestors: BlueskyPost[] = [];
    let cursor = thread.parent;
    while (isThreadViewPost(cursor)) {
      ancestors.unshift(simplifyPost(cursor.post));
      cursor = cursor.parent;
    }

    const descendants: BlueskyPost[] = [];
    collectDescendants(thread, descendants);

    return { ancestors, descendants };
  }

  private async resolveDid(): Promise<string> {
    if (this.did) return this.did;
    const resp = await this.agent.getProfile({ actor: this.handle });
    this.did = resp.data.did;
    return this.did;
  }

  private async publicFollowingFeed(limit: number): Promise<BlueskyPost[]> {
    const did = await this.resolveDid();
    const followsResp = await this.agent.app.bsky.graph.getFollows({ actor: did, limit: 100 });
    const follows = followsResp.data.follows;

    // Fetch all author feeds in parallel; individual failures don't abort the rest.
    const results = await Promise.allSettled(
      follows.map((f) => this.agent.app.bsky.feed.getAuthorFeed({ actor: f.did, limit: 5 }))
    );

    const posts: BlueskyPost[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        posts.push(...r.value.data.feed.map((item) => simplifyPost(item.post)));
      }
    }

    posts.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
    return posts.slice(0, limit);
  }
}

// Loosely typed on purpose, same reasoning as BlueskyRecord below - a
// minimal duck-typed shape rather than importing @atproto/api's internal
// generated thread types, so a library version bump can't silently break
// this at the type level. Exported (with the two functions below) for unit
// testing - this recursive flattening is real logic worth verifying
// directly, not just via a live call in src/test.ts.
export interface ThreadNode {
  post?: SimplifyablePost;
  parent?: ThreadNode;
  replies?: ThreadNode[];
}

// NotFoundPost/BlockedPost (deleted, blocked, or otherwise inaccessible
// nodes in the tree) have no `post` field - skip them rather than throw.
export function isThreadViewPost(node: unknown): node is ThreadNode & { post: SimplifyablePost } {
  return Boolean(node) && typeof node === "object" && (node as ThreadNode).post !== undefined;
}

export function collectDescendants(node: ThreadNode, out: BlueskyPost[]): void {
  for (const reply of node.replies ?? []) {
    if (!isThreadViewPost(reply)) continue;
    out.push(simplifyPost(reply.post));
    collectDescendants(reply, out);
  }
}

function atUriToWebUrl(uri: string, handle: string): string {
  // AT URI: at://did:plc:xxx/app.bsky.feed.post/rkey
  const rkey = uri.split("/").pop() ?? "";
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

interface SimplifyablePost {
  uri: string;
  author: { handle: string };
  record: unknown;
  likeCount?: number;
  repostCount?: number;
  replyCount?: number;
  quoteCount?: number;
}

export function simplifyPost(post: SimplifyablePost): BlueskyPost {
  const record = post.record as BlueskyRecord;
  const urls: string[] = [];
  const hashtags: string[] = [];
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features) {
      if (feature.$type === "app.bsky.richtext.facet#link" && feature.uri) {
        urls.push(feature.uri);
      } else if (feature.$type === "app.bsky.richtext.facet#tag" && feature.tag) {
        hashtags.push(feature.tag);
      }
    }
  }
  return {
    uri: post.uri,
    url: atUriToWebUrl(post.uri, post.author.handle),
    author: post.author.handle,
    created_at: record.createdAt ?? "",
    text: record.text ?? "",
    likes: post.likeCount ?? 0,
    repost_count: post.repostCount ?? 0,
    reply_count: post.replyCount ?? 0,
    quote_count: post.quoteCount ?? 0,
    urls: [...new Set(urls)],
    hashtags: [...new Set(hashtags)],
    ...(record.reply?.parent?.uri ? { reply_parent_uri: record.reply.parent.uri } : {}),
    ...(record.reply?.root?.uri ? { reply_root_uri: record.reply.root.uri } : {}),
  };
}
