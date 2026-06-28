/**
 * Read-only social feed MCP server (TypeScript).
 *
 * Exposes ONLY read tools across Mastodon, Bluesky, and Nostr, each
 * supporting multiple configured accounts. There is no post / favourite /
 * like / repost / follow tool defined anywhere. An agent connected to this
 * server can fetch and summarize, full stop — the write surface doesn't
 * exist for it to call, accidentally or otherwise.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadConfig } from "./config.js";
import { loadState, saveState, getCursor, setCursor } from "./state.js";
import { MastodonReadClient } from "./clients/mastodon.js";
import { BlueskyReadClient } from "./clients/bluesky.js";
import { NostrReadClient, npubToHex } from "./clients/nostr.js";
import { clean } from "./clean.js";

// ── Client registries ────────────────────────────────────────────────────────

type Clients = {
  mastodon: Record<string, MastodonReadClient>;
  bluesky: Record<string, BlueskyReadClient>;
  nostr: Record<string, NostrReadClient>;
};

function buildClients(config: ReturnType<typeof loadConfig>): Clients {
  const mastodon: Record<string, MastodonReadClient> = {};
  for (const a of config.mastodon) {
    mastodon[a.id] = new MastodonReadClient(a.instance_url, a.access_token);
  }

  const bluesky: Record<string, BlueskyReadClient> = {};
  for (const a of config.bluesky) {
    bluesky[a.id] = new BlueskyReadClient(a.handle, a.app_password);
  }

  const nostr: Record<string, NostrReadClient> = {};
  for (const a of config.nostr) {
    nostr[a.id] = new NostrReadClient(npubToHex(a.npub), a.relays);
  }

  return { mastodon, bluesky, nostr };
}

let config = loadConfig();
let clients = buildClients(config);

// ── Handler helpers ──────────────────────────────────────────────────────────

function aid(a: Record<string, unknown>): string {
  const v = a.account_id;
  if (typeof v !== "string" || !v) throw new Error('Missing or invalid required argument: "account_id"');
  return v;
}

function lim(a: Record<string, unknown>, def: number): number {
  const v = Number(a.limit);
  return Math.min(Number.isFinite(v) && v > 0 ? Math.floor(v) : def, 200);
}

function str(a: Record<string, unknown>, key: string): string | undefined {
  const v = a[key];
  return typeof v === "string" && v ? v : undefined;
}

function requireClient<T>(registry: Record<string, T>, accountId: string, platform: string): T {
  if (!(accountId in registry)) throw new Error(`Unknown ${platform} account_id: "${accountId}"`);
  return registry[accountId];
}

function mxl(a: Record<string, unknown>): number | undefined {
  const v = Number(a.max_content_length);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function mp(a: Record<string, unknown>): number {
  const v = Number(a.max_pages);
  return Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), 10) : 1;
}

// ── MCP server setup ─────────────────────────────────────────────────────────
//
// createConfiguredServer() is a factory rather than a module-level singleton
// so HTTP mode can create one Server per request (stateless transport pattern).
// In stdio mode the factory is called exactly once.
//
// Handler closures reference the module-level `config` and `clients` variables,
// so all Server instances — whether one (stdio) or many (HTTP) — share the same
// social platform connections and cursor state file.

const LIMIT_SCHEMA = { type: "number", minimum: 1, maximum: 200 } as const;
const MAX_PAGES_SCHEMA = {
  type: "number",
  minimum: 1,
  maximum: 10,
  default: 1,
  description: "Internally fetch up to this many pages and concatenate the results. Use 2–5 for catch-up scans when many posts may have accumulated since the last cursor. Default: 1 (single-page, current behaviour).",
} as const;
const ADVANCE_CURSOR_SCHEMA = {
  type: "boolean",
  description: "If false, fetch posts without advancing the cursor (safe for debugging or partial analysis). Default: true.",
  default: true,
} as const;
const INCLUDE_HTML_SCHEMA = {
  type: "boolean",
  description: "Include raw HTML fields (text_html, original_text_html). Default: false (omits them to reduce token usage).",
  default: false,
} as const;
const MAX_CONTENT_LENGTH_SCHEMA = {
  type: "number",
  minimum: 1,
  description: "Truncate text/content fields to this many characters. Omit for no truncation.",
} as const;

function createConfiguredServer(): Server {
  const srv = new Server(
    { name: "social-reader", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_accounts",
      description: "List every configured account, grouped by platform. Call this first — the account_id arguments below come from here.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mastodon_home_timeline",
      description: "Fetch recent home-timeline posts for a configured Mastodon account. Returns plain text with engagement counts, mentions, hashtags, and link previews. HTML fields omitted by default.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          advance_cursor: ADVANCE_CURSOR_SCHEMA,
          max_pages: MAX_PAGES_SCHEMA,
          include_html: INCLUDE_HTML_SCHEMA,
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_favourites",
      description: "Fetch this Mastodon account's own favourites (engagement history). HTML fields omitted by default.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          max_id: { type: "string", description: "Return results older than this post ID (for pagination)." },
          include_html: INCLUDE_HTML_SCHEMA,
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_bookmarks",
      description: "Fetch this Mastodon account's saved bookmarks (strong engagement signal). HTML fields omitted by default.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          max_id: { type: "string", description: "Return results older than this post ID (for pagination)." },
          include_html: INCLUDE_HTML_SCHEMA,
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_reblogs",
      description: "Fetch this Mastodon account's own reblogs/boosts (engagement history). Returns next_max_id for pagination. HTML fields omitted by default.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          max_id: { type: "string", description: "Return statuses older than this ID (use next_max_id from a previous response)." },
          include_html: INCLUDE_HTML_SCHEMA,
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_timeline",
      description: "Fetch recent following-feed posts for a configured Bluesky account. Returns engagement counts, web URLs, and extracted hashtags/links.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          advance_cursor: ADVANCE_CURSOR_SCHEMA,
          max_pages: MAX_PAGES_SCHEMA,
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_likes",
      description: "Fetch this Bluesky account's own likes (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_reposts",
      description: "Fetch this Bluesky account's own reposts (engagement history). Returns cursor for pagination — each page scans the author feed and filters for reposts, so page size may be smaller than limit.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          cursor: { type: "string", description: "Pagination cursor from a previous response." },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_following_feed",
      description: "Fetch recent notes from accounts this Nostr npub follows. Returns nostr URIs, author npubs, hashtags, URLs, and reply/root thread IDs.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          hours: { type: "number", default: 24 },
          limit: { ...LIMIT_SCHEMA, default: 100 },
          advance_cursor: ADVANCE_CURSOR_SCHEMA,
          max_pages: MAX_PAGES_SCHEMA,
          include_engagement: {
            type: "boolean",
            description: "If true, fetch reaction, repost, and zap counts for each note via an extra relay query. Counts are approximate. Default: false.",
            default: false,
          },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_bookmarks",
      description: "Fetch this Nostr npub's NIP-51 bookmark list (kind 10003) — strong engagement signal.",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_reactions",
      description: "Fetch this Nostr npub's own published reactions/likes (engagement history). The reply_to_id field identifies the reacted event.",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, limit: { ...LIMIT_SCHEMA, default: 100 } },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_reposts",
      description: "Fetch this Nostr npub's own reposts/kind-6 events (engagement history).",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, limit: { ...LIMIT_SCHEMA, default: 100 } },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_zaps",
      description: "Fetch zaps this Nostr npub has sent (kind 9735 receipts via relay #P tag — engagement history).",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, limit: { ...LIMIT_SCHEMA, default: 50 } },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_get_event",
      description: "Fetch a single Nostr event by ID. Use this to dereference event IDs from bookmarks, reposts, zaps, or reaction targets.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          event_id: { type: "string", description: "Hex event ID to fetch." },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id", "event_id"],
      },
    },
    {
      name: "nostr_get_events",
      description: "Fetch multiple Nostr events by ID in one relay query. Use this to batch-dereference IDs from bookmarks, reposts, or zap targets.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          event_ids: {
            type: "array",
            items: { type: "string" },
            description: "List of hex event IDs to fetch (max 50).",
          },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id", "event_ids"],
      },
    },
    {
      name: "nostr_get_profile",
      description: "Fetch a Nostr profile (kind 0 metadata) by hex pubkey. Returns name, display_name, about, picture, website, and nip05.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          pubkey: { type: "string", description: "Hex pubkey of the profile to fetch." },
        },
        required: ["account_id", "pubkey"],
      },
    },
    {
      name: "nostr_get_article",
      description: "Fetch a NIP-23 long-form article (kind 30023) by article address. Use this to dereference article_addr values returned by nostr_my_bookmarks.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          article_addr: { type: "string", description: 'NIP-51 article address in "30023:<pubkey>:<d-tag>" format, as returned by nostr_my_bookmarks.' },
          max_content_length: MAX_CONTENT_LENGTH_SCHEMA,
        },
        required: ["account_id", "article_addr"],
      },
    },
    {
      name: "mark_seen",
      description: "Advance the cursor for a feed without fetching — call after analyzing posts retrieved with advance_cursor: false. cursor_value is: the post id for Mastodon, the created_at ISO string for Bluesky, or the created_at unix timestamp for Nostr.",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["mastodon", "bluesky", "nostr"] },
          account_id: { type: "string" },
          cursor_value: {
            description: "Mastodon: post id (string). Bluesky: created_at ISO string. Nostr: created_at unix timestamp (number).",
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
        required: ["platform", "account_id", "cursor_value"],
      },
    },
    {
      name: "reload_config",
      description: "Reload config.yaml and reinitialize all clients without restarting the server.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args;

  try {
    let result: unknown;

    switch (name) {
      case "list_accounts":
        result = {
          mastodon: Object.keys(clients.mastodon).map((id) => ({
            id,
            read_only_guarantee: "credential-enforced (OAuth token registered with read scope only)",
          })),
          bluesky: Object.keys(clients.bluesky).map((id) => ({
            id,
            authenticated: clients.bluesky[id].authenticated,
            read_only_guarantee: clients.bluesky[id].authenticated
              ? "code-enforced (only read API methods called; app passwords are not scope-limited by the platform)"
              : "public AppView (unauthenticated, no credentials stored)",
          })),
          nostr: Object.keys(clients.nostr).map((id) => ({
            id,
            read_only_guarantee: "structural (public key only; no private key stored means publishing is cryptographically impossible)",
          })),
        };
        break;

      case "mastodon_home_timeline": {
        const accountId = aid(a);
        const client = requireClient(clients.mastodon, accountId, "mastodon");
        const state = loadState();
        const cursor = getCursor(state, "mastodon", accountId);
        const posts = await client.homeTimeline(lim(a, 40), cursor.since_id, mp(a));
        if (a.advance_cursor !== false && posts.length > 0) {
          let maxId = posts[0].id;
          for (const p of posts) {
            try {
              if (BigInt(p.id) > BigInt(maxId)) maxId = p.id;
            } catch { /* non-integer id, skip */ }
          }
          setCursor(state, "mastodon", accountId, { since_id: maxId });
          saveState(state);
        }
        const ih = a.include_html === true;
        const ml = mxl(a);
        result = posts.map((p) => clean(p, ih, ml));
        break;
      }

      case "mastodon_bookmarks": {
        const posts = await requireClient(clients.mastodon, aid(a), "mastodon")
          .bookmarks(lim(a, 40), str(a, "max_id"));
        const ih = a.include_html === true;
        const ml = mxl(a);
        result = posts.map((p) => clean(p, ih, ml));
        break;
      }

      case "mastodon_favourites": {
        const posts = await requireClient(clients.mastodon, aid(a), "mastodon")
          .favourites(lim(a, 40), str(a, "max_id"));
        const ih = a.include_html === true;
        const ml = mxl(a);
        result = posts.map((p) => clean(p, ih, ml));
        break;
      }

      case "mastodon_reblogs": {
        const r = await requireClient(clients.mastodon, aid(a), "mastodon")
          .reblogs(lim(a, 40), str(a, "max_id"));
        const ih = a.include_html === true;
        const ml = mxl(a);
        result = {
          next_max_id: r.next_max_id,
          reblogs: r.reblogs.map((p) => clean(p, ih, ml)),
        };
        break;
      }

      case "bluesky_timeline": {
        const accountId = aid(a);
        const client = requireClient(clients.bluesky, accountId, "bluesky");
        const state = loadState();
        const cursor = getCursor(state, "bluesky", accountId);
        const posts = await client.timeline(lim(a, 40), cursor.since, mp(a));
        if (a.advance_cursor !== false && posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "bluesky", accountId, { since: maxTs });
          saveState(state);
        }
        const ml = mxl(a);
        result = ml ? posts.map((p) => clean(p, true, ml)) : posts;
        break;
      }

      case "bluesky_likes": {
        const r = await requireClient(clients.bluesky, aid(a), "bluesky")
          .likes(lim(a, 40), str(a, "cursor"));
        const ml = mxl(a);
        result = ml ? { ...r, posts: r.posts.map((p) => clean(p, true, ml)) } : r;
        break;
      }

      case "bluesky_reposts": {
        const r = await requireClient(clients.bluesky, aid(a), "bluesky")
          .reposts(lim(a, 40), str(a, "cursor"));
        const ml = mxl(a);
        result = ml ? { ...r, posts: r.posts.map((p) => clean(p, true, ml)) } : r;
        break;
      }

      case "nostr_following_feed": {
        const accountId = aid(a);
        const client = requireClient(clients.nostr, accountId, "nostr");
        const state = loadState();
        const cursor = getCursor(state, "nostr", accountId);
        const posts = await client.followingFeed(
          (a.hours as number) ?? 24,
          lim(a, 100),
          cursor.since_ts,
          a.include_engagement === true,
          mp(a)
        );
        if (a.advance_cursor !== false && posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "nostr", accountId, { since_ts: maxTs });
          saveState(state);
        }
        const ml = mxl(a);
        result = ml ? posts.map((p) => clean(p, true, ml)) : posts;
        break;
      }

      case "nostr_my_bookmarks":
        result = await requireClient(clients.nostr, aid(a), "nostr").myBookmarks();
        break;

      case "nostr_my_reactions":
        result = await requireClient(clients.nostr, aid(a), "nostr").myReactions(lim(a, 100));
        break;

      case "nostr_my_reposts":
        result = await requireClient(clients.nostr, aid(a), "nostr").myReposts(lim(a, 100));
        break;

      case "nostr_my_zaps":
        result = await requireClient(clients.nostr, aid(a), "nostr").myZaps(lim(a, 100));
        break;

      case "nostr_get_event": {
        const eventId = str(a, "event_id");
        if (!eventId) throw new Error('Missing required argument: "event_id"');
        const r = await requireClient(clients.nostr, aid(a), "nostr").getEvent(eventId);
        const ml = mxl(a);
        result = r && ml ? clean(r, true, ml) : r;
        break;
      }

      case "nostr_get_events": {
        const ids = a.event_ids;
        if (!Array.isArray(ids) || ids.length === 0) throw new Error('Missing or empty required argument: "event_ids"');
        const validIds = ids.filter((id): id is string => typeof id === "string").slice(0, 50);
        const notes = await requireClient(clients.nostr, aid(a), "nostr").getEvents(validIds);
        const ml = mxl(a);
        result = ml ? notes.map((p) => clean(p, true, ml)) : notes;
        break;
      }

      case "nostr_get_profile": {
        const pubkey = str(a, "pubkey");
        if (!pubkey) throw new Error('Missing required argument: "pubkey"');
        result = await requireClient(clients.nostr, aid(a), "nostr").getProfile(pubkey);
        break;
      }

      case "nostr_get_article": {
        const articleAddr = str(a, "article_addr");
        if (!articleAddr) throw new Error('Missing required argument: "article_addr"');
        const r = await requireClient(clients.nostr, aid(a), "nostr").getArticle(articleAddr);
        const ml = mxl(a);
        result = r && ml ? clean(r, true, ml) : r;
        break;
      }

      case "mark_seen": {
        const platform = a.platform;
        if (platform !== "mastodon" && platform !== "bluesky" && platform !== "nostr") {
          throw new Error(`Invalid platform: "${String(platform)}". Must be mastodon, bluesky, or nostr.`);
        }
        const accountId = aid(a);
        const cursorValue = a.cursor_value;
        const state = loadState();

        if (platform === "mastodon") {
          if (typeof cursorValue !== "string" || !cursorValue) {
            throw new Error("For mastodon, cursor_value must be a post id string.");
          }
          requireClient(clients.mastodon, accountId, "mastodon");
          setCursor(state, "mastodon", accountId, { since_id: cursorValue });
        } else if (platform === "bluesky") {
          if (typeof cursorValue !== "string" || !cursorValue) {
            throw new Error("For bluesky, cursor_value must be a created_at ISO string.");
          }
          requireClient(clients.bluesky, accountId, "bluesky");
          setCursor(state, "bluesky", accountId, { since: cursorValue });
        } else {
          const ts = Number(cursorValue);
          if (!Number.isFinite(ts) || ts <= 0) {
            throw new Error("For nostr, cursor_value must be a unix timestamp (the note's created_at).");
          }
          requireClient(clients.nostr, accountId, "nostr");
          setCursor(state, "nostr", accountId, { since_ts: ts });
        }

        saveState(state);
        result = { platform, account_id: accountId, cursor_value: cursorValue };
        break;
      }

      case "reload_config": {
        // Close old Nostr WebSocket connections before replacing clients.
        for (const c of Object.values(clients.nostr)) c.close();

        config = loadConfig();
        clients = buildClients(config);

        result = {
          mastodon: Object.keys(clients.mastodon),
          bluesky: Object.keys(clients.bluesky),
          nostr: Object.keys(clients.nostr),
        };
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
    };
  }
  });

  return srv;
}

// ── Start ─────────────────────────────────────────────────────────────────────
//
// SOCIAL_READER_TRANSPORT=http  → HTTP transport (bearer-token-gated LAN listener)
// unset or "stdio"              → stdio transport (default; byte-for-byte identical
//                                 to previous behaviour — zero risk to existing users)

if (process.env.SOCIAL_READER_TRANSPORT === "http") {
  // Dynamic import keeps this module out of the stdio path so stdio startup is
  // unchanged even on systems where the HTTP deps (node:http, timingSafeEqual,
  // etc.) might behave differently.
  const { startHttpServer } = await import("./http-transport.js");
  await startHttpServer(createConfiguredServer);
} else {
  const transport = new StdioServerTransport();
  await createConfiguredServer().connect(transport);
}
