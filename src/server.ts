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

// ── MCP server setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "social-reader", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

const LIMIT_SCHEMA = { type: "number", minimum: 1, maximum: 200 } as const;
const ADVANCE_CURSOR_SCHEMA = {
  type: "boolean",
  description: "If false, fetch posts without advancing the cursor (safe for debugging or partial analysis). Default: true.",
  default: true,
} as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_accounts",
      description: "List every configured account, grouped by platform. Call this first — the account_id arguments below come from here.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mastodon_home_timeline",
      description: "Fetch recent home-timeline posts for a configured Mastodon account. Returns plain text with engagement counts, mentions, hashtags, and link previews.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          advance_cursor: ADVANCE_CURSOR_SCHEMA,
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_favourites",
      description: "Fetch this Mastodon account's own favourites (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          max_id: { type: "string", description: "Return results older than this post ID (for pagination)." },
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_bookmarks",
      description: "Fetch this Mastodon account's saved bookmarks (strong engagement signal).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { ...LIMIT_SCHEMA, default: 40 },
          max_id: { type: "string", description: "Return results older than this post ID (for pagination)." },
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_reblogs",
      description: "Fetch this Mastodon account's own reblogs/boosts (engagement history).",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, limit: { ...LIMIT_SCHEMA, default: 40 } },
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
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_reposts",
      description: "Fetch this Bluesky account's own reposts (engagement history).",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" }, limit: { ...LIMIT_SCHEMA, default: 40 } },
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
          include_engagement: {
            type: "boolean",
            description: "If true, fetch reaction, repost, and zap counts for each note via an extra relay query. Counts are approximate. Default: false.",
            default: false,
          },
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
      name: "reload_config",
      description: "Reload config.yaml and reinitialize all clients without restarting the server.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

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
        const posts = await client.homeTimeline(lim(a, 40), cursor.since_id);
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
        result = posts;
        break;
      }

      case "mastodon_bookmarks":
        result = await requireClient(clients.mastodon, aid(a), "mastodon")
          .bookmarks(lim(a, 40), str(a, "max_id"));
        break;

      case "mastodon_favourites":
        result = await requireClient(clients.mastodon, aid(a), "mastodon")
          .favourites(lim(a, 40), str(a, "max_id"));
        break;

      case "mastodon_reblogs":
        result = await requireClient(clients.mastodon, aid(a), "mastodon").reblogs(lim(a, 40));
        break;

      case "bluesky_timeline": {
        const accountId = aid(a);
        const client = requireClient(clients.bluesky, accountId, "bluesky");
        const state = loadState();
        const cursor = getCursor(state, "bluesky", accountId);
        const posts = await client.timeline(lim(a, 40), cursor.since);
        if (a.advance_cursor !== false && posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "bluesky", accountId, { since: maxTs });
          saveState(state);
        }
        result = posts;
        break;
      }

      case "bluesky_likes":
        result = await requireClient(clients.bluesky, aid(a), "bluesky")
          .likes(lim(a, 40), str(a, "cursor"));
        break;

      case "bluesky_reposts":
        result = await requireClient(clients.bluesky, aid(a), "bluesky").reposts(lim(a, 40));
        break;

      case "nostr_following_feed": {
        const accountId = aid(a);
        const client = requireClient(clients.nostr, accountId, "nostr");
        const state = loadState();
        const cursor = getCursor(state, "nostr", accountId);
        const posts = await client.followingFeed(
          (a.hours as number) ?? 24,
          lim(a, 100),
          cursor.since_ts,
          a.include_engagement === true
        );
        if (a.advance_cursor !== false && posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "nostr", accountId, { since_ts: maxTs });
          saveState(state);
        }
        result = posts;
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
        result = await requireClient(clients.nostr, aid(a), "nostr").getEvent(eventId);
        break;
      }

      case "nostr_get_events": {
        const ids = a.event_ids;
        if (!Array.isArray(ids) || ids.length === 0) throw new Error('Missing or empty required argument: "event_ids"');
        const validIds = ids.filter((id): id is string => typeof id === "string").slice(0, 50);
        result = await requireClient(clients.nostr, aid(a), "nostr").getEvents(validIds);
        break;
      }

      case "nostr_get_profile": {
        const pubkey = str(a, "pubkey");
        if (!pubkey) throw new Error('Missing required argument: "pubkey"');
        result = await requireClient(clients.nostr, aid(a), "nostr").getProfile(pubkey);
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

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
