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
  author: string;
  created_at: string;
  text: string;
  likes: number;
}

// Shape of the record field inside a Bluesky post object.
interface BlueskyRecord {
  createdAt?: string;
  text?: string;
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

  async timeline(limit = 40, since?: string): Promise<BlueskyPost[]> {
    const fetchLimit = since ? Math.min(limit * 2, 100) : limit;
    let posts: BlueskyPost[];

    if (this.authenticated) {
      await this.ensureAuth();
      const resp = await this.agent.getTimeline({ limit: fetchLimit });
      posts = resp.data.feed.map((item) => simplifyPost(item.post));
    } else {
      posts = await this.publicFollowingFeed(fetchLimit);
    }

    if (since) posts = posts.filter((p) => p.created_at > since);
    return posts.slice(0, limit);
  }

  async likes(limit = 40): Promise<BlueskyPost[]> {
    await this.ensureAuth();
    const did = await this.resolveDid();
    const resp = await this.agent.app.bsky.feed.getActorLikes({ actor: did, limit });
    return resp.data.feed.map((item) => simplifyPost(item.post));
  }

  async reposts(limit = 40): Promise<BlueskyPost[]> {
    await this.ensureAuth();
    const did = await this.resolveDid();
    const resp = await this.agent.app.bsky.feed.getAuthorFeed({
      actor: did,
      limit: Math.min(limit * 3, 100),
    });
    return resp.data.feed
      .filter((item) => item.reason?.$type === "app.bsky.feed.defs#reasonRepost")
      .slice(0, limit)
      .map((item) => simplifyPost(item.post));
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

function simplifyPost(post: { uri: string; author: { handle: string }; record: unknown; likeCount?: number }): BlueskyPost {
  const record = post.record as BlueskyRecord;
  return {
    uri: post.uri,
    author: post.author.handle,
    created_at: record.createdAt ?? "",
    text: record.text ?? "",
    likes: post.likeCount ?? 0,
  };
}
