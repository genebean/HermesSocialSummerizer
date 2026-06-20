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

function buildClients(config: ReturnType<typeof loadConfig>) {
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

// ── MCP server setup ─────────────────────────────────────────────────────────

const server = new Server(
  { name: "social-reader", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_accounts",
      description: "List every configured account, grouped by platform. Call this first — the account_id arguments below come from here.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mastodon_home_timeline",
      description: "Fetch recent home-timeline posts for a configured Mastodon account.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 40 },
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
          limit: { type: "number", default: 40 },
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
          limit: { type: "number", default: 40 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "mastodon_reblogs",
      description: "Fetch this Mastodon account's own reblogs/boosts (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 40 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_timeline",
      description: "Fetch recent following-feed posts for a configured Bluesky account.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 40 },
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
          limit: { type: "number", default: 40 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "bluesky_reposts",
      description: "Fetch this Bluesky account's own reposts (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 40 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_following_feed",
      description: "Fetch recent notes from accounts this Nostr npub follows.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          hours: { type: "number", default: 24 },
          limit: { type: "number", default: 100 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_bookmarks",
      description: "Fetch this Nostr npub's NIP-51 bookmark list (kind 10003) — strong engagement signal.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_reactions",
      description: "Fetch this Nostr npub's own published reactions/likes (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 100 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_reposts",
      description: "Fetch this Nostr npub's own reposts/kind-6 events (engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 100 },
        },
        required: ["account_id"],
      },
    },
    {
      name: "nostr_my_zaps",
      description: "Fetch zaps this Nostr npub has sent (kind 9735 receipts via relay #P tag — engagement history).",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          limit: { type: "number", default: 50 },
        },
        required: ["account_id"],
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
          mastodon: Object.keys(clients.mastodon),
          bluesky: Object.keys(clients.bluesky),
          nostr: Object.keys(clients.nostr),
        };
        break;

      case "mastodon_home_timeline": {
        const state = loadState();
        const cursor = getCursor(state, "mastodon", a.account_id as string);
        const posts = await clients.mastodon[a.account_id as string].homeTimeline(
          (a.limit as number) ?? 40,
          cursor.since_id as string | undefined
        );
        if (posts.length > 0) {
          const maxId = posts.reduce((m, p) => (BigInt(p.id) > BigInt(m) ? p.id : m), posts[0].id);
          setCursor(state, "mastodon", a.account_id as string, { since_id: maxId });
          saveState(state);
        }
        result = posts;
        break;
      }

      case "mastodon_bookmarks":
        result = await clients.mastodon[a.account_id as string].bookmarks((a.limit as number) ?? 40);
        break;

      case "mastodon_favourites":
        result = await clients.mastodon[a.account_id as string].favourites((a.limit as number) ?? 40);
        break;

      case "mastodon_reblogs":
        result = await clients.mastodon[a.account_id as string].reblogs((a.limit as number) ?? 40);
        break;

      case "bluesky_timeline": {
        const state = loadState();
        const cursor = getCursor(state, "bluesky", a.account_id as string);
        const posts = await clients.bluesky[a.account_id as string].timeline(
          (a.limit as number) ?? 40,
          cursor.since as string | undefined
        );
        if (posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "bluesky", a.account_id as string, { since: maxTs });
          saveState(state);
        }
        result = posts;
        break;
      }

      case "bluesky_likes":
        result = await clients.bluesky[a.account_id as string].likes((a.limit as number) ?? 40);
        break;

      case "bluesky_reposts":
        result = await clients.bluesky[a.account_id as string].reposts((a.limit as number) ?? 40);
        break;

      case "nostr_following_feed": {
        const state = loadState();
        const cursor = getCursor(state, "nostr", a.account_id as string);
        const posts = await clients.nostr[a.account_id as string].followingFeed(
          (a.hours as number) ?? 24,
          (a.limit as number) ?? 100,
          cursor.since_ts as number | undefined
        );
        if (posts.length > 0) {
          const maxTs = posts.reduce((m, p) => (p.created_at > m ? p.created_at : m), posts[0].created_at);
          setCursor(state, "nostr", a.account_id as string, { since_ts: maxTs });
          saveState(state);
        }
        result = posts;
        break;
      }

      case "nostr_my_bookmarks":
        result = await clients.nostr[a.account_id as string].myBookmarks();
        break;

      case "nostr_my_reactions":
        result = await clients.nostr[a.account_id as string].myReactions((a.limit as number) ?? 100);
        break;

      case "nostr_my_reposts":
        result = await clients.nostr[a.account_id as string].myReposts((a.limit as number) ?? 100);
        break;

      case "nostr_my_zaps":
        result = await clients.nostr[a.account_id as string].myZaps((a.limit as number) ?? 100);
        break;

      case "reload_config": {
        // Cache-busting query forces Node's ESM loader to re-evaluate each
        // module, picking up TypeScript source changes without a restart.
        const v = Date.now();
        const u = (p: string) => `${new URL(p, import.meta.url).href}?v=${v}`;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [cfgMod, mstdnMod, bskyMod, nsrMod]: any[] = await Promise.all([
          import(u("./config.js")),
          import(u("./clients/mastodon.js")),
          import(u("./clients/bluesky.js")),
          import(u("./clients/nostr.js")),
        ]);

        config = cfgMod.loadConfig();
        clients = {
          mastodon: Object.fromEntries(
            config.mastodon.map((a) => [a.id, new mstdnMod.MastodonReadClient(a.instance_url, a.access_token)])
          ),
          bluesky: Object.fromEntries(
            config.bluesky.map((a) => [a.id, new bskyMod.BlueskyReadClient(a.handle, a.app_password)])
          ),
          nostr: Object.fromEntries(
            config.nostr.map((a) => [a.id, new nsrMod.NostrReadClient(nsrMod.npubToHex(a.npub), a.relays)])
          ),
        } as typeof clients;

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
