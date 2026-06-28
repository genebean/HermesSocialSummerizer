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
      token: process.env.SOCIAL_READER_HTTP_TOKEN,
      host: process.env.SOCIAL_READER_HTTP_HOST,
      port: process.env.SOCIAL_READER_HTTP_PORT,
    };
    process.env.SOCIAL_READER_HTTP_TOKEN = TOKEN;
    process.env.SOCIAL_READER_HTTP_HOST = "127.0.0.1";
    process.env.SOCIAL_READER_HTTP_PORT = "0"; // OS picks a free ephemeral port

    srv = await startHttpServer(makeMinimalServer);
    const addr = srv.address() as import("node:net").AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;

    // Restore — the server captured what it needed during startup.
    process.env.SOCIAL_READER_HTTP_TOKEN = saved.token;
    process.env.SOCIAL_READER_HTTP_HOST = saved.host;
    process.env.SOCIAL_READER_HTTP_PORT = saved.port;
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
