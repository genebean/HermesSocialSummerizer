# HermesSocialSummerizer

A read-only MCP server for Mastodon, Bluesky, and Nostr, supporting multiple
accounts per platform. Built so that an agent (Hermes, Claude, or anything
else speaking MCP) has tools to *fetch and summarize* feeds and never a tool
to post, like, follow, or otherwise write anywhere.

## Why this is actually read-only, not just policy-read-only

| Platform | Guarantee | Why |
|---|---|---|
| Nostr | **Structural** | Only the npub (public key) is ever stored. Posting requires signing with the nsec (secret key), which never exists anywhere in this project. There is no key to misuse. |
| Mastodon | **Credential-enforced** | Register the OAuth app with the `read` scope only. The instance itself rejects any write call from that token, regardless of what code runs against it. |
| Bluesky | **Code-enforced, with a credential-free mode** | Bluesky app passwords are not scope-limited. If you omit `app_password` in the config, this account is read entirely through Bluesky's public `public.api.bsky.app` AppView with zero credentials. Supply an app password only if you want the real algorithmic "Following" feed; treat it as a dedicated, revocable credential. |

On top of all three: this codebase contains no `post_status`, `create_post`,
`like`, `follow`, `repost`, or `publish_event` function. You can grep for it.

## Layout

```
HermesSocialSummerizer/
  src/
    server.ts           # MCP server — tool definitions and handlers
    config.ts           # Config loader with ${ENV_VAR} expansion
    state.ts            # Cursor/pagination state (atomic JSON writes)
    clients/
      mastodon.ts       # Native fetch, read-only Mastodon client
      bluesky.ts        # @atproto/api, handles JWT refresh automatically
      nostr.ts          # nostr-tools SimplePool, EOSE-based relay queries
  config.example.yaml   # Copy to config.yaml and fill in
  package.json
  tsconfig.json
  .mcp.json             # Wires this server into Claude Code / Hermes
```

## Setup

```bash
cd HermesSocialSummerizer
npm install
cp config.example.yaml config.yaml
# edit config.yaml — add your accounts and env var names for secrets
```

Create a `.env` file with your actual credentials:

```bash
MASTODON_MAIN_TOKEN=your_read_only_access_token
BSKY_PERSONAL_APP_PW=your_app_password   # optional
```

The server loads `.env` automatically at startup via `dotenv`.

## Running

Verify every client method works against your live credentials:

```bash
npm test
```

The server speaks MCP over stdio. Run it directly to sanity-check:

```bash
node_modules/.bin/tsx src/server.ts
```

In practice it is launched by the MCP host (Claude Code, Hermes, etc.) via
`.mcp.json`, which already points to the local `tsx` binary — no global
install needed.

## Tools

Call `list_accounts` first to get the account IDs used by all other tools.

### Timelines / feeds

| Tool | Platform | Description |
|---|---|---|
| `list_accounts` | all | Returns configured account IDs grouped by platform |
| `mastodon_home_timeline` | Mastodon | Home timeline; cursor-tracked to avoid re-reading |
| `bluesky_timeline` | Bluesky | Following feed; cursor-tracked |
| `nostr_following_feed` | Nostr | Notes from followed pubkeys; cursor-tracked |

### Engagement history (strong interest signals)

| Tool | Platform | Signal |
|---|---|---|
| `mastodon_favourites` | Mastodon | Posts you favourited |
| `mastodon_reblogs` | Mastodon | Posts you boosted |
| `mastodon_bookmarks` | Mastodon | Posts you saved/bookmarked |
| `bluesky_likes` | Bluesky | Posts you liked |
| `bluesky_reposts` | Bluesky | Posts you reposted |
| `nostr_my_reactions` | Nostr | Kind 7 reactions you published |
| `nostr_my_reposts` | Nostr | Kind 6 reposts you published |
| `nostr_my_bookmarks` | Nostr | NIP-51 kind 10003 bookmark list |
| `nostr_my_zaps` | Nostr | Kind 9735 zap receipts where you are the sender |

### Utility

| Tool | Description |
|---|---|
| `reload_config` | Reloads `config.yaml` and reinitializes all clients without restarting the server. Also hot-reloads any client code changes. |

### Parameters

Every tool except `list_accounts` and `reload_config` requires `account_id`
(a string matching one of the IDs in `config.yaml`). Timeline tools accept an
optional `limit` (default 40 for Mastodon/Bluesky, 100 for Nostr).
`nostr_following_feed` also accepts `hours` (default 24).

Response-size controls are available for agent-friendly summaries:

- Mastodon tools omit raw HTML fields (`text_html`, `original_text_html`) by
  default. Pass `include_html: true` when an agent explicitly needs the source
  HTML rather than the plain-text fields.
- Mastodon, Bluesky, and content-returning Nostr tools accept
  `max_content_length`. When set, long `text`, `original_text`, or `content`
  fields are truncated with a suffix such as `…[+123 chars]` so the caller can
  tell how much text was omitted.

## Cursor state

The three timeline tools (`mastodon_home_timeline`, `bluesky_timeline`,
`nostr_following_feed`) track a cursor in `cursor_state.json` so successive
calls return only new content rather than re-reading the same window. The
cursor advances on every successful fetch. Delete `cursor_state.json` to
reset to a fresh read.

## Engagement signal notes

- **Nostr zaps** are fetched from relay kind 9735 events using the `#P` tag
  filter (sender pubkey). This gives full event context — which post was
  zapped, recipient pubkey, amount, and message — without requiring a
  Lightning wallet connection.
- **Bluesky saved posts** are off-protocol and private with no API exposure.
  Not currently fetchable.
- **Nostr bookmarks** may contain both notes (`event_id`) and long-form
  articles (`article_addr` in `kind:pubkey:d-tag` format).

## Wiring into Claude Code

`.mcp.json` is already configured:

```json
{
  "mcpServers": {
    "social-reader": {
      "command": "/path/to/HermesSocialSummerizer/node_modules/.bin/tsx",
      "args": ["/path/to/HermesSocialSummerizer/src/server.ts"]
    }
  }
}
```

Update the paths to match your checkout location.

## Wiring into Hermes

```yaml
mcp_servers:
  social-reader:
    command: /path/to/HermesSocialSummerizer/node_modules/.bin/tsx
    args: ["/path/to/HermesSocialSummerizer/src/server.ts"]
    env:
      MASTODON_MAIN_TOKEN: "..."
      BSKY_PERSONAL_APP_PW: "..."
```

Example cron prompt:

```
/cron add "0 8 * * *" "Call list_accounts. For every configured Mastodon,
Bluesky, and Nostr account, fetch its recent timeline and all engagement
history tools. Summarize new posts by theme, weighting heavily any content
whose author or topic overlaps with the account's engagement history
(bookmarks, likes, zaps, reposts). Deliver digest to Matrix."
```

## Credential setup per platform

**Mastodon** — register an OAuth app on your instance (Settings >
Development) with the `read` scope *only*. Use the resulting access token.
The instance will reject any write attempt from this token at the server
level.

**Bluesky** — generate a dedicated app password (Settings > App Passwords).
Keep it separate from any password shared with another tool; it is
independently revocable. Omit it entirely for public-only reads.

**Nostr** — only your npub (public key) goes in `config.yaml`. The nsec
never touches this project. No key management, no risk of key exposure.
