/**
 * Integration smoke tests — exercises every client method against live APIs.
 * Runs with: npm test
 *
 * Each test passes if the method returns without throwing (empty arrays are fine;
 * they mean the API responded but has no data in that window). Tests are skipped
 * when the relevant account is not configured.
 */
import { loadConfig } from "./config.js";
import { MastodonReadClient } from "./clients/mastodon.js";
import { BlueskyReadClient } from "./clients/bluesky.js";
import { NostrReadClient, npubToHex } from "./clients/nostr.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type Result = { name: string; status: "pass" | "fail" | "skip"; ms: number; detail: string };
const results: Result[] = [];

async function run(name: string, fn: () => Promise<unknown>): Promise<void> {
  const start = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - start;
    const count = Array.isArray(value) ? ` (${value.length} items)` : "";
    results.push({ name, status: "pass", ms, detail: `${ms}ms${count}` });
  } catch (e) {
    const ms = Date.now() - start;
    results.push({ name, status: "fail", ms, detail: String(e instanceof Error ? e.message : e) });
  }
}

function skip(name: string, reason: string): void {
  results.push({ name, status: "skip", ms: 0, detail: reason });
}

// ── Load config ───────────────────────────────────────────────────────────────

console.log(`\n${DIM}Loading config...${RESET}`);
let config: ReturnType<typeof loadConfig>;
try {
  config = loadConfig();
} catch (e) {
  console.error(`${RED}FATAL: config failed to load — ${e instanceof Error ? e.message : e}${RESET}`);
  process.exit(1);
}
console.log(
  `${DIM}  mastodon: ${config.mastodon.map((a) => a.id).join(", ") || "none"}${RESET}`
);
console.log(
  `${DIM}  bluesky:  ${config.bluesky.map((a) => a.id).join(", ") || "none"}${RESET}`
);
console.log(
  `${DIM}  nostr:    ${config.nostr.map((a) => a.id).join(", ") || "none"}${RESET}\n`
);

// ── Mastodon ──────────────────────────────────────────────────────────────────

for (const acct of config.mastodon) {
  const c = new MastodonReadClient(acct.instance_url, acct.access_token);
  const p = `mastodon[${acct.id}]`;
  await run(`${p}.homeTimeline`, () => c.homeTimeline(5));
  await run(`${p}.favourites`, () => c.favourites(5));
  await run(`${p}.bookmarks`, () => c.bookmarks(5));
  await run(`${p}.reblogs`, () => c.reblogs(5));
}

if (config.mastodon.length === 0) skip("mastodon.*", "no mastodon accounts configured");

// ── Bluesky ───────────────────────────────────────────────────────────────────

for (const acct of config.bluesky) {
  const c = new BlueskyReadClient(acct.handle, acct.app_password);
  const p = `bluesky[${acct.id}]`;
  await run(`${p}.timeline`, () => c.timeline(5));
  await run(`${p}.likes`, () => c.likes(5));
  await run(`${p}.reposts`, () => c.reposts(5));
}

if (config.bluesky.length === 0) skip("bluesky.*", "no bluesky accounts configured");

// ── Nostr ─────────────────────────────────────────────────────────────────────

const nostrClients: NostrReadClient[] = [];

for (const acct of config.nostr) {
  const c = new NostrReadClient(npubToHex(acct.npub), acct.relays);
  nostrClients.push(c);
  const p = `nostr[${acct.id}]`;
  await run(`${p}.followingFeed`, () => c.followingFeed(24, 5));
  await run(`${p}.myReactions`, () => c.myReactions(5));
  await run(`${p}.myReposts`, () => c.myReposts(5));
  await run(`${p}.myBookmarks`, () => c.myBookmarks());
  await run(`${p}.myZaps`, () => c.myZaps(5));
}

if (config.nostr.length === 0) skip("nostr.*", "no nostr accounts configured");

// Close Nostr pools
for (const c of nostrClients) c.close();

// ── Report ────────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
let passed = 0, failed = 0, skipped = 0;

for (const r of results) {
  if (r.status === "pass") {
    console.log(`${GREEN}PASS${RESET}  ${r.name.padEnd(45)} ${DIM}${r.detail}${RESET}`);
    passed++;
  } else if (r.status === "fail") {
    console.log(`${RED}FAIL${RESET}  ${r.name.padEnd(45)} ${RED}${r.detail}${RESET}`);
    failed++;
  } else {
    console.log(`${YELLOW}SKIP${RESET}  ${r.name.padEnd(45)} ${DIM}${r.detail}${RESET}`);
    skipped++;
  }
}

console.log("─".repeat(60));
console.log(
  `${passed} passed  ${failed > 0 ? RED : ""}${failed} failed${RESET}  ${skipped} skipped\n`
);

if (failed > 0) process.exit(1);
