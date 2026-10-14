/**
 * CI-safe unit tests — no network, no credentials, no config.yaml needed.
 *
 * Run with:
 *   npm run unit
 *   node --import tsx/esm --test src/unit-tests.ts
 *
 * These tests cover pure utility functions and the HTTP transport's auth
 * logic, including a live-server integration test that binds a local port
 * and exercises the full request/response path.
 *
 * Addresses issue #4: extract CI-safe tests from src/test.ts.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { clean, trunc } from "./clean.js";
import { MAX_LOOKBACK_HOURS, clampLookbackHours, clampSinceTs } from "./lookback.js";
import { collectDescendants, isThreadViewPost, simplifyPost, type BlueskyPost, type ThreadNode } from "./clients/bluesky.js";
import { MastodonReadClient, simplifyStatus } from "./clients/mastodon.js";
import { isLoopback, tokenMatch, startHttpServer } from "./http-transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Make an HTTP request and return { status, body }. */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpPost(
  url: string,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** Minimal MCP Server with no tools — just enough for the HTTP transport to connect to. */
function makeMinimalServer(): Server {
  const srv = new Server({ name: "unit-test", version: "0.0.0" }, { capabilities: { tools: {} } });
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  return srv;
}

// ── trunc() ───────────────────────────────────────────────────────────────────

describe("trunc", () => {
  test("returns string unchanged when within length", () => {
    assert.equal(trunc("hello", 10), "hello");
  });

  test("returns string unchanged when exactly at length", () => {
    assert.equal(trunc("hello", 5), "hello");
  });

  test("truncates and appends correct suffix", () => {
    const s = "a".repeat(20);
    const result = trunc(s, 10);
    assert.ok(result.startsWith("a".repeat(10)), "prefix should be first 10 chars");
    assert.ok(result.includes("…[+10 chars]"), `suffix missing in: ${result}`);
  });

  test("suffix reports correct char count", () => {
    const result = trunc("x".repeat(100), 40);
    assert.ok(result.includes("…[+60 chars]"), `wrong count in: ${result}`);
  });
});

// ── lookback (hard API-protection ceiling) ──────────────────────────────────────

describe("clampLookbackHours", () => {
  test("passes through a requested value under the ceiling", () => {
    assert.equal(clampLookbackHours(12, 24), 12);
  });

  test("clamps a requested value over the ceiling", () => {
    assert.equal(clampLookbackHours(MAX_LOOKBACK_HOURS * 10, 24), MAX_LOOKBACK_HOURS);
  });

  test("uses the fallback when nothing is requested", () => {
    assert.equal(clampLookbackHours(undefined, 24), 24);
  });

  test("uses the fallback for a non-finite or non-positive request", () => {
    assert.equal(clampLookbackHours(NaN, 24), 24);
    assert.equal(clampLookbackHours(0, 24), 24);
    assert.equal(clampLookbackHours(-5, 24), 24);
  });

  test("clamps a fallback that itself exceeds the ceiling", () => {
    assert.equal(clampLookbackHours(undefined, MAX_LOOKBACK_HOURS * 10), MAX_LOOKBACK_HOURS);
  });
});

describe("clampSinceTs", () => {
  test("passes through a recent timestamp unchanged", () => {
    const recent = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(clampSinceTs(recent), recent);
  });

  test("clamps a timestamp older than the ceiling up to the floor", () => {
    const tenYearsAgo = Math.floor(Date.now() / 1000) - 10 * 365 * 24 * 3600;
    const result = clampSinceTs(tenYearsAgo);
    const floorTs = Math.floor(Date.now() / 1000) - MAX_LOOKBACK_HOURS * 3600;
    assert.ok(result !== undefined && result >= floorTs, `expected clamped to floor, got ${result}`);
    assert.notEqual(result, tenYearsAgo);
  });

  test("returns undefined for a missing/non-numeric/non-positive value", () => {
    assert.equal(clampSinceTs(undefined), undefined);
    assert.equal(clampSinceTs("not-a-number"), undefined);
    assert.equal(clampSinceTs(0), undefined);
    assert.equal(clampSinceTs(-100), undefined);
  });
});

// ── clean() ───────────────────────────────────────────────────────────────────

describe("clean", () => {
  test("strips text_html by default", () => {
    const post = { id: "1", text: "hello", text_html: "<p>hello</p>", author: "user" };
    const out = clean(post, false);
    assert.ok(!("text_html" in out), "text_html should be absent when includeHtml=false");
    assert.equal(out.text, "hello", "text should be preserved");
  });

  test("keeps text_html when includeHtml=true", () => {
    const post = { id: "1", text: "hello", text_html: "<p>hello</p>", author: "user" };
    const out = clean(post, true);
    assert.equal(out.text_html, "<p>hello</p>", "text_html should be present when includeHtml=true");
  });

  test("strips original_text_html by default", () => {
    const reblog = { id: "1", original_text: "hi", original_text_html: "<p>hi</p>" };
    const out = clean(reblog, false);
    assert.ok(!("original_text_html" in out), "original_text_html should be absent");
    assert.equal(out.original_text, "hi", "original_text should be preserved");
  });

  test("truncates text field when maxLen set", () => {
    const post = { text: "a".repeat(200), author: "x" };
    const out = clean(post, true, 50);
    const t = out.text as string;
    assert.ok(t.includes("…[+"), "truncated text should include ellipsis suffix");
    assert.ok(!t.startsWith("a".repeat(51)), "text should be cut at 50 chars");
  });

  test("truncates content field when maxLen set", () => {
    const article = { title: "My Article", content: "x".repeat(5000) };
    const out = clean(article, true, 100);
    const c = out.content as string;
    assert.ok(c.includes("…[+"), "truncated content should include ellipsis suffix");
    assert.equal(out.title, "My Article", "non-content field should be unchanged");
  });

  test("does not truncate text shorter than maxLen", () => {
    const post = { text: "short text", author: "x" };
    const out = clean(post, true, 200);
    assert.equal(out.text, "short text", "short text should be unchanged");
  });

  test("passes through unknown fields unchanged", () => {
    const post = { id: "1", likes: 42, tags: ["a", "b"], nested: { x: 1 } };
    const out = clean(post as Record<string, unknown>, true);
    assert.equal(out.id, "1");
    assert.equal(out.likes, 42);
    assert.ok(Array.isArray(out.tags), "tags should pass through as array");
  });
});

// ── Bluesky thread flattening (bluesky_post_thread) ─────────────────────────────

function threadNode(uri: string, replies: ThreadNode[] = []): ThreadNode {
  return {
    post: { uri, author: { handle: "user.test" }, record: { text: "t", createdAt: "2026-01-01T00:00:00Z" } },
    replies,
  };
}

describe("isThreadViewPost", () => {
  test("returns true for a node with a post", () => {
    assert.ok(isThreadViewPost(threadNode("at://1")));
  });

  test("returns false for a NotFoundPost/BlockedPost-shaped node (no post field)", () => {
    assert.ok(!isThreadViewPost({ uri: "at://missing", notFound: true }));
  });

  test("returns false for null/undefined", () => {
    assert.ok(!isThreadViewPost(undefined));
    assert.ok(!isThreadViewPost(null));
  });
});

describe("collectDescendants", () => {
  test("collects direct replies in order", () => {
    const node = threadNode("at://root", [threadNode("at://reply1"), threadNode("at://reply2")]);
    const out: BlueskyPost[] = [];
    collectDescendants(node, out);
    assert.deepEqual(out.map((p) => p.uri), ["at://reply1", "at://reply2"]);
  });

  test("recurses into nested replies (reply-to-a-reply)", () => {
    const node = threadNode("at://root", [threadNode("at://reply1", [threadNode("at://reply1-1")])]);
    const out: BlueskyPost[] = [];
    collectDescendants(node, out);
    assert.deepEqual(out.map((p) => p.uri), ["at://reply1", "at://reply1-1"]);
  });

  test("skips NotFoundPost/BlockedPost replies instead of throwing", () => {
    const node: ThreadNode = {
      post: threadNode("at://root").post,
      replies: [{ uri: "at://blocked", blocked: true } as unknown as ThreadNode, threadNode("at://visible-reply")],
    };
    const out: BlueskyPost[] = [];
    collectDescendants(node, out);
    assert.deepEqual(out.map((p) => p.uri), ["at://visible-reply"]);
  });

  test("returns an empty array for a leaf node with no replies", () => {
    const out: BlueskyPost[] = [];
    collectDescendants(threadNode("at://leaf"), out);
    assert.deepEqual(out, []);
  });
});

describe("simplifyPost (Bluesky reply fields)", () => {
  function post(record: Record<string, unknown>) {
    return simplifyPost({ uri: "at://1", author: { handle: "user.test" }, record });
  }

  test("sets reply_parent_uri and reply_root_uri from record.reply", () => {
    const p = post({
      text: "t",
      createdAt: "2026-01-01T00:00:00Z",
      reply: { parent: { uri: "at://parent" }, root: { uri: "at://root" } },
    });
    assert.equal(p.reply_parent_uri, "at://parent");
    assert.equal(p.reply_root_uri, "at://root");
  });

  test("leaves both unset for a standalone post (no record.reply)", () => {
    const p = post({ text: "t", createdAt: "2026-01-01T00:00:00Z" });
    assert.equal(p.reply_parent_uri, undefined);
    assert.equal(p.reply_root_uri, undefined);
  });
});

describe("simplifyStatus (Mastodon reply field)", () => {
  function rawStatus(overrides: Record<string, unknown> = {}) {
    return {
      id: "1",
      account: { acct: "user@instance.test" },
      content: "<p>t</p>",
      created_at: "2026-01-01T00:00:00Z",
      url: "https://instance.test/@user/1",
      in_reply_to_id: null,
      favourited: false,
      reblogged: false,
      reblog: null,
      favourites_count: 0,
      reblogs_count: 0,
      replies_count: 0,
      language: null,
      mentions: [],
      tags: [],
      card: null,
      ...overrides,
    } as Parameters<typeof simplifyStatus>[0];
  }

  test("sets in_reply_to_id from a reply status", () => {
    const p = simplifyStatus(rawStatus({ in_reply_to_id: "42" }));
    assert.equal(p.in_reply_to_id, "42");
  });

  test("leaves in_reply_to_id null for a standalone status", () => {
    const p = simplifyStatus(rawStatus());
    assert.equal(p.in_reply_to_id, null);
  });

  test("reads in_reply_to_id from the reblogged status, not the wrapper", () => {
    const p = simplifyStatus(
      rawStatus({
        reblog: rawStatus({ id: "99", in_reply_to_id: "7" }),
      })
    );
    assert.equal(p.in_reply_to_id, "7");
  });
});

// ── MastodonReadClient.statusContext id validation ──────────────────────────────
//
// Unlike every other field this client accepts, `id` here gets interpolated
// into a URL path rather than passed as a URLSearchParams query value - a
// malicious id could otherwise redirect this authenticated request to a
// different endpoint on the same instance. The validation runs
// synchronously before any fetch, so this is testable with no live
// credentials or network access at all.

describe("MastodonReadClient.statusContext id validation", () => {
  const client = new MastodonReadClient("https://example.test", "dummy-token");

  test("rejects a path-traversal id before making any request", async () => {
    await assert.rejects(() => client.statusContext("../../oauth/revoke"), /Invalid Mastodon status id/);
  });

  test("rejects an id carrying a query-string injection", async () => {
    await assert.rejects(() => client.statusContext("123?foo=bar"), /Invalid Mastodon status id/);
  });

  test("rejects a non-numeric id", async () => {
    await assert.rejects(() => client.statusContext("abc"), /Invalid Mastodon status id/);
  });

  test("rejects an empty id", async () => {
    await assert.rejects(() => client.statusContext(""), /Invalid Mastodon status id/);
  });
});

// ── isLoopback() ──────────────────────────────────────────────────────────────

describe("isLoopback", () => {
  test("returns true for 127.0.0.1", () => assert.ok(isLoopback("127.0.0.1")));
  test("returns true for ::1", () => assert.ok(isLoopback("::1")));
  test("returns true for localhost", () => assert.ok(isLoopback("localhost")));
  test("returns false for LAN IPv4", () => assert.ok(!isLoopback("192.168.1.10")));
  test("returns false for 0.0.0.0", () => assert.ok(!isLoopback("0.0.0.0")));
  test("returns false for empty string", () => assert.ok(!isLoopback("")));
});

// ── tokenMatch() ──────────────────────────────────────────────────────────────

describe("tokenMatch", () => {
  test("returns true for identical strings", () => {
    assert.ok(tokenMatch("mysecrettoken", "mysecrettoken"));
  });

  test("returns false for different strings of same length", () => {
    assert.ok(!tokenMatch("aaaaaaaaaaaaa", "bbbbbbbbbbbbb"));
  });

  test("returns false when lengths differ", () => {
    assert.ok(!tokenMatch("short", "much-longer-token"));
  });

  test("returns false for empty string vs non-empty", () => {
    assert.ok(!tokenMatch("token", ""));
  });

  test("returns true for empty string vs empty string", () => {
    // Edge case: two empty tokens match. The no-token startup guard prevents
    // an empty token from ever being configured, so this is defensive only.
    assert.ok(tokenMatch("", ""));
  });

  test("is case-sensitive", () => {
    assert.ok(!tokenMatch("Token", "token"));
  });
});

// ── HTTP transport integration ────────────────────────────────────────────────
//
// Starts a real HTTP server on a random local port (port 0 → OS assigns a free
// ephemeral port), runs the request/response tests, then tears it down. No
// external services, no credentials required — CI-safe.

describe("HTTP transport", () => {
  const TOKEN = "test-unit-token-abc123";

  // These are set in before() and used by each test.
  let srv: import("node:http").Server;
  let base: string;

  before(async () => {
    // Set env vars the server reads at startup, then restore after binding so
    // the rest of the process is not polluted.
    const saved = {
      token: process.env.SOCIAL_READER_MCP_HTTP_TOKEN,
      host: process.env.SOCIAL_READER_MCP_HTTP_HOST,
      port: process.env.SOCIAL_READER_MCP_HTTP_PORT,
    };
    process.env.SOCIAL_READER_MCP_HTTP_TOKEN = TOKEN;
    process.env.SOCIAL_READER_MCP_HTTP_HOST = "127.0.0.1";
    process.env.SOCIAL_READER_MCP_HTTP_PORT = "0"; // OS picks a free ephemeral port

    srv = await startHttpServer(makeMinimalServer);
    const addr = srv.address() as import("node:net").AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    // Restore — the server captured what it needed during startup.
    process.env.SOCIAL_READER_MCP_HTTP_TOKEN = saved.token;
    process.env.SOCIAL_READER_MCP_HTTP_HOST = saved.host;
    process.env.SOCIAL_READER_MCP_HTTP_PORT = saved.port;
  });

  after(async () => {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });

  test("GET /healthz returns 200 without auth", async () => {
    const { status, body } = await httpGet(`${base}/healthz`);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { status: "ok" });
  });

  test("POST /mcp without Authorization header returns 401", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const { status } = await httpPost(`${base}/mcp`, payload);
    assert.equal(status, 401);
  });

  test("POST /mcp with wrong token returns 401", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const { status } = await httpPost(`${base}/mcp`, payload, { Authorization: "Bearer wrong-token" });
    assert.equal(status, 401);
  });

  test("POST /mcp with correct token returns valid MCP response", async () => {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    // The MCP Streamable HTTP transport requires both application/json and
    // text/event-stream in the Accept header (per the MCP spec).
    const { status, body } = await httpPost(`${base}/mcp`, payload, {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/json, text/event-stream",
    });
    assert.equal(status, 200);
    // The transport uses SSE format: extract the JSON-RPC message from data lines.
    // Lines look like: "data: {"jsonrpc":"2.0","id":1,"result":{...}}"
    const dataLine = body.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(dataLine, `no SSE data line found in response body: ${body}`);
    const parsed = JSON.parse(dataLine!.slice(6));
    // A valid JSON-RPC response has an "id" field matching the request.
    assert.ok("id" in parsed, `expected JSON-RPC response with id, got: ${JSON.stringify(parsed)}`);
  });

  test("authenticated request to unknown route returns 404", async () => {
    const { status } = await httpGet(`${base}/unknown-route`, {
      Authorization: `Bearer ${TOKEN}`,
    });
    assert.equal(status, 404);
  });
});
