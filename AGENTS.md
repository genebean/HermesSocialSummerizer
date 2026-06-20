# AGENTS.md — HermesSocialSummerizer

This file is the authoritative working guide for any agent operating in this
repository. It is fully self-contained — do not assume any parent or sibling
file is available.

---

## Who You're Working With

The owner is an experienced infrastructure engineer (SRE) who manages Linux
fleets, runs a NixOS homelab, and is comfortable in a terminal. He is **not an
application developer**. When working on application code:

- Comment generously — future maintenance may be done by an agent without full
  context, or by the owner returning to code he didn't write
- Prefer explicit over implicit — avoid patterns that require deep framework
  knowledge to maintain
- Prefer simple over clever — the best solution is the one that's easiest to
  understand six months later
- If something is non-obvious, explain it in a comment at the point of use

---

## What This Project Is

**HermesSocialSummerizer** is a read-only MCP (Model Context Protocol) server
that aggregates Mastodon, Bluesky, and Nostr feeds for an LLM agent to fetch
and summarize. It exposes 14 read-only tools and deliberately has no write
surface whatsoever.

### Read-Only Guarantees (per platform)

| Platform | Guarantee | Mechanism |
|---|---|---|
| Nostr | **Structural** | Only the npub (public key) is ever stored. Publishing requires signing with the nsec (private key), which has no place in this codebase. The capability simply does not exist. |
| Mastodon | **Credential-enforced** | The OAuth token must be registered with `read` scope only at the instance level. The instance rejects any write call regardless of what code runs against it. |
| Bluesky | **Code-enforced** | App passwords are not scope-limited by the platform. Only read methods (`getTimeline`, `getActorLikes`, `getAuthorFeed`, `getFollows`, `getProfile`) are called. A public-AppView mode with no credentials at all is also supported. |

**Do not add any tool, function, or method that writes to any platform.** This
means no `post_status`, `create_post`, `like`, `favourite`, `follow`,
`repost`, `publish_event`, or any equivalent. If an agent or user requests
a write capability, decline and explain the design intent.

**Never store or handle an nsec (Nostr private key) anywhere in this project.**

---

## Project Layout

```
HermesSocialSummerizer/
  src/
    server.ts           # MCP server — tool definitions and request handlers
    config.ts           # Config loader with ${ENV_VAR} expansion and Zod validation
    state.ts            # Cursor/pagination state (atomic JSON writes, in-memory cache)
    clients/
      mastodon.ts       # Read-only Mastodon client (native fetch, GET only)
      bluesky.ts        # Read-only Bluesky client (@atproto/api, read methods only)
      nostr.ts          # Read-only Nostr client (nostr-tools SimplePool, subscribe only)
    test.ts             # Integration smoke tests (excluded from production build)
  config.example.yaml   # Copy to config.yaml and fill in
  config.yaml           # Live config (gitignored — contains secret references)
  .env                  # Actual secret values (gitignored)
  cursor_state.json     # Pagination cursors (gitignored — runtime state)
  .mcp.json             # Wires server into Claude Code / Hermes
  package.json
  tsconfig.json
```

Key architectural points:
- The server runs via `tsx` (TypeScript execute) — no compilation step needed at runtime
- Clients are long-lived instances built once at startup and reused across tool calls
- `state.ts` keeps an in-memory cursor store loaded once at startup; disk writes are atomic (tmp + rename)
- `config.ts` expands `${ENV_VAR}` references in `config.yaml` from environment variables before Zod validation

---

## Tooling Contract

This project has **no `flake.nix`** and therefore no Nix dev shell. Tooling
comes from `npm`:

```bash
npm install          # install dependencies into node_modules/
npm test             # run integration smoke tests against live APIs
npm run typecheck    # type-check without emitting output
npm run build        # compile TypeScript to dist/ (rarely needed; tsx runs src/ directly)
npm start            # start the MCP server (normally launched by the MCP host, not manually)
```

The `tsx` binary used at runtime lives at `node_modules/.bin/tsx`. The
`.mcp.json` points to it with an absolute path — update that path if the repo
is relocated.

**Pre-push verification:**
1. `npm run typecheck` — must pass with zero errors
2. `npm test` — must pass all tests (requires a live `config.yaml` and `.env`)

If `npm test` cannot be run (no live credentials available), note this
explicitly rather than claiming the tests pass.

---

## Infrastructure Preferences

When making architectural decisions or suggesting approaches:

- **Self-hosted over cloud** — prefer infrastructure the owner controls over
  third-party SaaS or cloud services
- **Open-source over proprietary** — all else being equal, prefer open-source
  tools and services
- **Self-sovereign data** — avoid patterns where the owner's data is in custody
  of a third party unless there is a compelling reason with no self-hosted
  alternative
- **Simple over clever** — the least complex solution that meets the
  requirements is the right one

These are preferences, not absolute rules. External services are acceptable
when they are read-only lookups (e.g. public APIs), when self-hosting is
genuinely impractical, or when the spec explicitly accepts a trade-off.

---

## Config and Secrets

**`config.yaml`** holds account definitions. Secrets are never written
directly into it — instead, use `${ENV_VAR}` placeholders:

```yaml
mastodon:
  - id: main
    instance_url: "https://mastodon.social"
    access_token: "${MASTODON_MAIN_TOKEN}"
```

Actual values live in **`.env`** (loaded automatically by `dotenv` at startup)
or in the environment passed by the MCP host. Both files are gitignored.

**Zod validation** runs at startup (and on `reload_config`). Schema rules
enforced by the config loader:
- `instance_url` must use `https://`
- Relay URLs must use `wss://`
- `npub` must start with `npub1`
- At least one relay must be configured per Nostr account

The `SOCIAL_READER_CONFIG` environment variable overrides the default
`config.yaml` path. `CURSOR_STATE_PATH` overrides the default
`cursor_state.json` path.

---

## MCP Tools Reference

All tools except `list_accounts` and `reload_config` require an `account_id`
argument. Call `list_accounts` first to get the IDs. Limit parameters default
to 40 (Mastodon/Bluesky) or 100 (Nostr) and are capped at 200.

| Tool | Platform | Notes |
|---|---|---|
| `list_accounts` | all | Returns accounts with per-platform read_only_guarantee |
| `mastodon_home_timeline` | Mastodon | Cursor-tracked — successive calls return only new posts |
| `mastodon_favourites` | Mastodon | Engagement history |
| `mastodon_bookmarks` | Mastodon | Strong engagement signal |
| `mastodon_reblogs` | Mastodon | Capped at 40/page by Mastodon API; may return fewer than limit |
| `bluesky_timeline` | Bluesky | Cursor-tracked; unauthenticated mode reconstructs feed from follows |
| `bluesky_likes` | Bluesky | Requires authentication |
| `bluesky_reposts` | Bluesky | Requires authentication |
| `nostr_following_feed` | Nostr | Cursor-tracked; also accepts `hours` (default 24) |
| `nostr_my_reactions` | Nostr | Kind 7 events |
| `nostr_my_reposts` | Nostr | Kind 6 events |
| `nostr_my_bookmarks` | Nostr | NIP-51 kind 10003 list; returns event IDs and article addresses |
| `nostr_my_zaps` | Nostr | Kind 9735 receipts via #P tag; includes amount, message, zapped event |
| `reload_config` | all | Re-reads config.yaml and rebuilds all clients; no restart needed |

---

## Documentation Standard

**All project documentation (beyond README.md) is written as pure HTML files.**

- Documentation lives in a `docs/` directory at the repo root
- Files are plain `.html` — no static site generator, no build step
- Do not use Markdown for documentation pages
- Do not introduce Jekyll, Hugo, MkDocs, Docusaurus, or any other generator
- Navigate between pages with standard `<a href>` links

If a `docs/` directory is added, wire up GitHub Pages via this workflow:

```yaml
# .github/workflows/docs.yml
on:
  push:
    branches: [main]
    paths: ['docs/**']
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: docs
      - id: deployment
        uses: actions/deploy-pages@v4
```

GitHub Pages must be configured in repo settings to use **GitHub Actions** as
the source (not a branch).

---

## Project Spec Discipline

Non-trivial projects should have an authoritative spec at
`docs/reference/spec.html`. This project does not have one yet. If
significant architectural decisions are made or the project grows substantially,
create it. The spec should document:
- Why the project exists and what it does
- All major architectural and technology decisions and the reasoning behind them
- A decision log of settled choices

Rules for agents:
- **Read the spec before making any structural changes** (once it exists)
- **Update the spec when making decisions** that belong in it — do not let it
  drift from reality
- If the spec and the code conflict, flag it rather than silently picking one

---

## Commit and PR Hygiene

- Write commit messages as descriptions of what the code **is**, not what
  changed. For non-trivial commits, include a body: one short paragraph per
  major component describing what it does, key decisions, and any non-obvious
  constraints. A subject line alone is not sufficient for features. Reserve
  before/after framing for bug fixes only.
- Incremental local commits are fine as a working tool for rollback or local
  context, but must be squashed before pushing. What reaches the remote should
  reflect the final, complete state of the work — shaped from the full diff.
  Multiple commits in a pushed PR are only justified when changes represent
  genuinely independent logical concerns.
- If a follow-up fix is caught after committing (even after pushing), amend
  immediately and silently — use `--force-with-lease` if already pushed. Do not
  wait to be asked.
- If a change affects any `docs/` page, update those docs in the same branch
  and PR. Do not finish a feature and then ask whether it needs docs. The only
  exception is a standalone docs-only change with no associated code.
- After every push that changes what a PR does, update the PR description:
  `gh pr edit <N> --body "..."`. Base it entirely on `git log main..HEAD` —
  never carry forward bullet points that no longer reflect the code.
- When writing `gh pr create` or `gh pr edit` bodies containing backticks, use
  `PREOF` (not `EOF`) as the heredoc delimiter. Inside
  `$(cat <<'EOF' ... EOF)`, backticks are interpreted as command substitution
  by the outer shell; `PREOF` prevents this.
- Do not bundle unrelated changes in a single commit.

---

## Pre-push Verification

Before pushing any code change:

1. **`npm run typecheck`** — must complete with zero errors
2. **`npm test`** — must pass all integration tests against live APIs. If live
   credentials are unavailable, state this explicitly rather than skipping the
   step and claiming success
3. **Verify before reporting success** — run the thing. Do not assume
   correctness because the code looks right

---

## Git Branch Workflow

- Always start new work from a fresh main:
  `git checkout main && git pull`, then `git checkout -b <branch-name>`
- Delete merged branches locally after the PR merges:
  `git branch -d <old-branch>`
- Only rebase when there is actual divergence from main. Before opening a PR,
  check `git log --oneline origin/main..HEAD`. If main has not moved ahead of
  your branch base, rebasing rewrites commit SHAs for no reason and should be
  skipped.
