/**
 * Integration smoke tests — exercises every client method against live APIs.
 * Runs with: npm test
 *
 * Each test passes if the method returns without throwing (empty arrays are fine;
 * they mean the API responded but has no data in that window). Tests are skipped
 * when the relevant account is not configured.
 */
import { loadConfig } from "./config.js";
import { MastodonReadClient, type MastodonPost, type MastodonReblog } from "./clients/mastodon.js";
import { BlueskyReadClient, type BlueskyPost } from "./clients/bluesky.js";
import { NostrReadClient, npubToHex, type NostrNote, type NostrArticle } from "./clients/nostr.js";

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

// Validate that an item has all expected keys with the right types.
// Throws with a descriptive message on first mismatch.
function checkShape<T extends object>(label: string, item: T, checks: Partial<Record<keyof T, string>>): void {
  for (const [key, expectedType] of Object.entries(checks) as [keyof T, string][]) {
    const actual = typeof item[key];
    if (actual !== expectedType) {
      throw new Error(`${label}.${String(key)}: expected ${expectedType}, got ${actual} (value: ${JSON.stringify(item[key])})`);
    }
  }
}

function checkMastodonPost(p: MastodonPost, label: string): void {
  checkShape(label, p, {
    id: "string",
    author: "string",
    created_at: "string",
    text: "string",
    text_html: "string",
    favourited: "boolean",
    boosted: "boolean",
    favourites_count: "number",
    reblogs_count: "number",
    replies_count: "number",
  });
  if (!Array.isArray(p.mentions)) throw new Error(`${label}.mentions must be an array`);
  if (!Array.isArray(p.hashtags)) throw new Error(`${label}.hashtags must be an array`);
  if (!Array.isArray(p.urls)) throw new Error(`${label}.urls must be an array`);
  if (p.text_html && p.text === p.text_html) {
    throw new Error(`${label}.text should be plain text, not identical to text_html`);
  }
}

function checkMastodonReblog(r: MastodonReblog, label: string): void {
  checkShape(label, r, {
    id: "string",
    reblogged_at: "string",
    original_author: "string",
    original_text: "string",
    original_text_html: "string",
    original_favourites_count: "number",
    original_reblogs_count: "number",
    original_replies_count: "number",
  });
}

function checkBlueskyPost(p: BlueskyPost, label: string): void {
  checkShape(label, p, {
    uri: "string",
    url: "string",
    author: "string",
    created_at: "string",
    text: "string",
    likes: "number",
    repost_count: "number",
    reply_count: "number",
    quote_count: "number",
  });
  if (!Array.isArray(p.urls)) throw new Error(`${label}.urls must be an array`);
  if (!Array.isArray(p.hashtags)) throw new Error(`${label}.hashtags must be an array`);
  if (!p.url.startsWith("https://bsky.app/")) {
    throw new Error(`${label}.url should be a bsky.app web URL, got: ${p.url}`);
  }
}

function checkNostrNote(n: NostrNote, label: string): void {
  checkShape(label, n, {
    id: "string",
    nostr_uri: "string",
    author: "string",
    author_npub: "string",
    created_at: "number",
    text: "string",
  });
  if (!n.nostr_uri.startsWith("nostr:note1")) {
    throw new Error(`${label}.nostr_uri should start with nostr:note1, got: ${n.nostr_uri}`);
  }
  if (!n.author_npub.startsWith("npub1")) {
    throw new Error(`${label}.author_npub should start with npub1, got: ${n.author_npub}`);
  }
  if (!Array.isArray(n.hashtags)) throw new Error(`${label}.hashtags must be an array`);
  if (!Array.isArray(n.urls)) throw new Error(`${label}.urls must be an array`);
  if (!Array.isArray(n.mentioned_pubkeys)) throw new Error(`${label}.mentioned_pubkeys must be an array`);
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

  let timelinePosts: MastodonPost[] = [];
  await run(`${p}.homeTimeline`, async () => {
    timelinePosts = await c.homeTimeline(5);
    return timelinePosts;
  });
  if (timelinePosts.length > 0) {
    await run(`${p}.homeTimeline.shape`, async () => {
      checkMastodonPost(timelinePosts[0], `${p}.homeTimeline[0]`);
      return `validated ${timelinePosts.length} posts`;
    });
  }

  let favourites: MastodonPost[] = [];
  await run(`${p}.favourites`, async () => {
    favourites = await c.favourites(5);
    return favourites;
  });
  if (favourites.length > 0) {
    await run(`${p}.favourites.shape`, async () => {
      checkMastodonPost(favourites[0], `${p}.favourites[0]`);
      return `validated ${favourites.length} posts`;
    });
    // Test max_id pagination: fetch page 2 starting from the oldest result
    const oldestId = favourites[favourites.length - 1].id;
    await run(`${p}.favourites.pagination`, () => c.favourites(5, oldestId));
  }

  let bookmarks: MastodonPost[] = [];
  await run(`${p}.bookmarks`, async () => {
    bookmarks = await c.bookmarks(5);
    return bookmarks;
  });
  if (bookmarks.length > 0) {
    await run(`${p}.bookmarks.shape`, async () => {
      checkMastodonPost(bookmarks[0], `${p}.bookmarks[0]`);
      return `validated ${bookmarks.length} posts`;
    });
    const oldestId = bookmarks[bookmarks.length - 1].id;
    await run(`${p}.bookmarks.pagination`, () => c.bookmarks(5, oldestId));
  }

  let reblogs: MastodonReblog[] = [];
  let reblogsNextMaxId: string | undefined;
  await run(`${p}.reblogs`, async () => {
    const resp = await c.reblogs(5);
    reblogs = resp.reblogs;
    reblogsNextMaxId = resp.next_max_id;
    return reblogs;
  });
  if (reblogs.length > 0) {
    await run(`${p}.reblogs.shape`, async () => {
      checkMastodonReblog(reblogs[0], `${p}.reblogs[0]`);
      return `validated ${reblogs.length} reblogs`;
    });
  }
  if (reblogsNextMaxId) {
    await run(`${p}.reblogs.pagination`, async () => {
      const resp = await c.reblogs(5, reblogsNextMaxId);
      return resp.reblogs;
    });
  }
}

if (config.mastodon.length === 0) skip("mastodon.*", "no mastodon accounts configured");

// ── Bluesky ───────────────────────────────────────────────────────────────────

for (const acct of config.bluesky) {
  const c = new BlueskyReadClient(acct.handle, acct.app_password);
  const p = `bluesky[${acct.id}]`;

  let timelinePosts: BlueskyPost[] = [];
  await run(`${p}.timeline`, async () => {
    timelinePosts = await c.timeline(5);
    return timelinePosts;
  });
  if (timelinePosts.length > 0) {
    await run(`${p}.timeline.shape`, async () => {
      checkBlueskyPost(timelinePosts[0], `${p}.timeline[0]`);
      return `validated ${timelinePosts.length} posts`;
    });
  }

  let likes: BlueskyPost[] = [];
  let likesCursor: string | undefined;
  await run(`${p}.likes`, async () => {
    const resp = await c.likes(5);
    likes = resp.posts;
    likesCursor = resp.cursor;
    return likes;
  });
  if (likes.length > 0) {
    await run(`${p}.likes.shape`, async () => {
      checkBlueskyPost(likes[0], `${p}.likes[0]`);
      return `validated ${likes.length} posts`;
    });
  }
  if (likesCursor) {
    await run(`${p}.likes.pagination`, async () => {
      const resp = await c.likes(5, likesCursor);
      return resp.posts;
    });
  }

  let reposts: BlueskyPost[] = [];
  let repostsCursor: string | undefined;
  await run(`${p}.reposts`, async () => {
    const resp = await c.reposts(5);
    reposts = resp.posts;
    repostsCursor = resp.cursor;
    return reposts;
  });
  if (reposts.length > 0) {
    await run(`${p}.reposts.shape`, async () => {
      checkBlueskyPost(reposts[0], `${p}.reposts[0]`);
      return `validated ${reposts.length} posts`;
    });
  }
  if (repostsCursor) {
    await run(`${p}.reposts.pagination`, async () => {
      const resp = await c.reposts(5, repostsCursor);
      return resp.posts;
    });
  }
}

if (config.bluesky.length === 0) skip("bluesky.*", "no bluesky accounts configured");

// ── Nostr ─────────────────────────────────────────────────────────────────────

const nostrClients: NostrReadClient[] = [];

for (const acct of config.nostr) {
  const pubkeyHex = npubToHex(acct.npub);
  const c = new NostrReadClient(pubkeyHex, acct.relays);
  nostrClients.push(c);
  const p = `nostr[${acct.id}]`;

  let feedNotes: NostrNote[] = [];
  await run(`${p}.followingFeed`, async () => {
    feedNotes = await c.followingFeed(24, 5);
    return feedNotes;
  });
  if (feedNotes.length > 0) {
    await run(`${p}.followingFeed.shape`, async () => {
      checkNostrNote(feedNotes[0], `${p}.followingFeed[0]`);
      return `validated ${feedNotes.length} notes`;
    });

    await run(`${p}.followingFeed.includeEngagement`, async () => {
      const notesWithEng = await c.followingFeed(24, 5, undefined, true);
      for (const n of notesWithEng) {
        if (n.engagement !== undefined) {
          const eng = n.engagement;
          if (typeof eng.reactions !== "number") throw new Error("engagement.reactions must be number");
          if (typeof eng.reposts !== "number") throw new Error("engagement.reposts must be number");
          if (typeof eng.zaps !== "number") throw new Error("engagement.zaps must be number");
          if (typeof eng.zap_total_sats !== "number") throw new Error("engagement.zap_total_sats must be number");
        }
      }
      const withEngCount = notesWithEng.filter((n) => n.engagement !== undefined).length;
      return `${notesWithEng.length} notes, ${withEngCount} with engagement data`;
    });

    // Test getEvent with a real ID from the feed
    await run(`${p}.getEvent`, async () => {
      const result = await c.getEvent(feedNotes[0].id);
      if (result === null) throw new Error(`getEvent returned null for known-good id ${feedNotes[0].id}`);
      checkNostrNote(result, `${p}.getEvent result`);
      return result;
    });

    // Test getEvents batch with up to 3 IDs from the feed
    const batchIds = feedNotes.slice(0, 3).map((n) => n.id);
    await run(`${p}.getEvents`, async () => {
      const fetched = await c.getEvents(batchIds);
      if (fetched.length === 0) throw new Error(`getEvents returned 0 results for ${batchIds.length} known-good IDs`);
      checkNostrNote(fetched[0], `${p}.getEvents[0]`);
      return fetched;
    });
  }

  await run(`${p}.myReactions`, () => c.myReactions(5));
  await run(`${p}.myReposts`, () => c.myReposts(5));

  let bookmarks: Awaited<ReturnType<typeof c.myBookmarks>> = [];
  await run(`${p}.myBookmarks`, async () => {
    bookmarks = await c.myBookmarks();
    return bookmarks;
  });

  // Test getEvents using bookmark event IDs
  const bookmarkEventIds = bookmarks
    .filter((b): b is Extract<typeof b, { kind: "event" }> => b.kind === "event")
    .map((b) => b.event_id)
    .slice(0, 3);
  if (bookmarkEventIds.length > 0) {
    await run(`${p}.getEvents.fromBookmarks`, async () => {
      const fetched = await c.getEvents(bookmarkEventIds);
      return fetched;
    });
  } else {
    skip(`${p}.getEvents.fromBookmarks`, "no event bookmarks to dereference");
  }

  // Test getArticle using article_addr values from bookmarks
  const articleAddrs = bookmarks
    .filter((b): b is Extract<typeof b, { kind: "article" }> => b.kind === "article")
    .map((b) => b.article_addr)
    .slice(0, 2);
  if (articleAddrs.length > 0) {
    await run(`${p}.getArticle`, async () => {
      const articles: (NostrArticle | null)[] = [];
      for (const addr of articleAddrs) {
        articles.push(await c.getArticle(addr));
      }
      const found = articles.filter((a): a is NostrArticle => a !== null);
      for (const a of found) {
        if (!a.nostr_uri.startsWith("nostr:note1")) throw new Error(`nostr_uri invalid: ${a.nostr_uri}`);
        if (!a.author_npub.startsWith("npub1")) throw new Error(`author_npub invalid: ${a.author_npub}`);
        if (!Array.isArray(a.hashtags)) throw new Error("hashtags must be an array");
        if (!Array.isArray(a.urls)) throw new Error("urls must be an array");
      }
      return `${articles.length} attempted, ${found.length} found`;
    });
  } else {
    skip(`${p}.getArticle`, "no article bookmarks to dereference");
  }

  await run(`${p}.myZaps`, () => c.myZaps(5));

  // Test getProfile using own pubkey
  await run(`${p}.getProfile.self`, async () => {
    const profile = await c.getProfile(pubkeyHex);
    if (profile !== null) {
      if (!profile.npub.startsWith("npub1")) throw new Error(`profile.npub invalid: ${profile.npub}`);
      if (profile.pubkey !== pubkeyHex) throw new Error("profile.pubkey mismatch");
    }
    return profile;
  });
}

if (config.nostr.length === 0) skip("nostr.*", "no nostr accounts configured");

// Close Nostr pools
for (const c of nostrClients) c.close();

// ── Report ────────────────────────────────────────────────────────────────────

console.log("─".repeat(60));
let passed = 0, failed = 0, skipped = 0;

for (const r of results) {
  if (r.status === "pass") {
    console.log(`${GREEN}PASS${RESET}  ${r.name.padEnd(50)} ${DIM}${r.detail}${RESET}`);
    passed++;
  } else if (r.status === "fail") {
    console.log(`${RED}FAIL${RESET}  ${r.name.padEnd(50)} ${RED}${r.detail}${RESET}`);
    failed++;
  } else {
    console.log(`${YELLOW}SKIP${RESET}  ${r.name.padEnd(50)} ${DIM}${r.detail}${RESET}`);
    skipped++;
  }
}

console.log("─".repeat(60));
console.log(
  `${passed} passed  ${failed > 0 ? RED : ""}${failed} failed${RESET}  ${skipped} skipped\n`
);

if (failed > 0) process.exit(1);
