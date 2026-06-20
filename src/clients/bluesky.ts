/**
 * Read-only Bluesky client using @atproto/api.
 * Authenticated mode: app_password supplied → uses real session with auto token refresh.
 * Public mode: no app_password → reads via public AppView (no credentials stored).
 *
 * App passwords are NOT scope-limited on Bluesky, so store them in a dedicated,
 * revocable app password separate from your main login.
 */
import { Agent, AtpAgent } from "@atproto/api";

const PUBLIC_SERVICE = "https://public.api.bsky.app";
const AUTH_SERVICE = "https://bsky.social";

export interface BlueskyPost {
  uri: string;
  author: string;
  created_at: string;
  text: string;
  likes: number;
}

export class BlueskyReadClient {
  private agent: AtpAgent;
  private authenticated = false;
  private did?: string;
  private readonly handle: string;

  constructor(handle: string, appPassword?: string) {
    this.handle = handle;
    if (appPassword) {
      this.agent = new AtpAgent({ service: AUTH_SERVICE });
      this.agent.login({ identifier: handle, password: appPassword });
      this.authenticated = true;
    } else {
      this.agent = new AtpAgent({ service: PUBLIC_SERVICE });
    }
  }

  async timeline(limit = 40, since?: string): Promise<BlueskyPost[]> {
    const fetchLimit = since ? Math.min(limit * 2, 100) : limit;
    let posts: BlueskyPost[];

    if (this.authenticated) {
      const resp = await this.agent.getTimeline({ limit: fetchLimit });
      posts = resp.data.feed.map((item) => simplifyPost(item.post));
    } else {
      posts = await this.publicFollowingFeed(fetchLimit);
    }

    if (since) posts = posts.filter((p) => p.created_at > since);
    return posts.slice(0, limit);
  }

  async likes(limit = 40): Promise<BlueskyPost[]> {
    const did = await this.resolveDid();
    if (this.authenticated) {
      const resp = await this.agent.app.bsky.feed.getActorLikes({ actor: did, limit });
      return resp.data.feed.map((item) => simplifyPost(item.post));
    } else {
      const resp = await this.agent.app.bsky.feed.getActorLikes({ actor: did, limit });
      return resp.data.feed.map((item) => simplifyPost(item.post));
    }
  }

  async reposts(limit = 40): Promise<BlueskyPost[]> {
    const did = await this.resolveDid();
    const agent = this.authenticated ? this.agent : new AtpAgent({ service: PUBLIC_SERVICE });
    const resp = await agent.app.bsky.feed.getAuthorFeed({
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
    const posts: BlueskyPost[] = [];
    for (const follow of followsResp.data.follows) {
      const feedResp = await this.agent.app.bsky.feed.getAuthorFeed({
        actor: follow.did,
        limit: 5,
      });
      posts.push(...feedResp.data.feed.map((item) => simplifyPost(item.post)));
    }
    posts.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
    return posts.slice(0, limit);
  }
}

function simplifyPost(post: { uri: string; author: { handle: string }; record: unknown; likeCount?: number }): BlueskyPost {
  const record = post.record as Record<string, unknown>;
  return {
    uri: post.uri,
    author: post.author.handle,
    created_at: (record.createdAt as string) ?? "",
    text: (record.text as string) ?? "",
    likes: post.likeCount ?? 0,
  };
}
