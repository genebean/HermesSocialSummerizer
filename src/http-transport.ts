/**
 * HTTP transport layer for social-reader.
 *
 * Wraps StreamableHTTPServerTransport with:
 *   - bearer token auth on every route except GET /healthz
 *   - stateless mode: each POST /mcp request gets its own transport + Server
 *     instance so there is no shared per-session state to race over
 *   - structured stderr logging for auth rejections — never logs the token value
 *
 * This module is only imported when SOCIAL_READER_MCP_TRANSPORT=http is set.
 * The stdio path in server.ts is entirely unchanged.
 *
 * Token sources (checked in order):
 *   SOCIAL_READER_MCP_HTTP_TOKEN      — literal token string in environment
 *   SOCIAL_READER_MCP_HTTP_TOKEN_FILE — path to a file whose content is the token
 *                                       (useful with sops-nix / agenix secret files;
 *                                        trailing whitespace / newlines are stripped)
 *
 * Network config:
 *   SOCIAL_READER_MCP_HTTP_HOST — address to bind (default 127.0.0.1)
 *   SOCIAL_READER_MCP_HTTP_PORT — port to listen on (default 8787)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── Token loading ─────────────────────────────────────────────────────────────

/**
 * Reads the bearer token from environment or from a file path in environment.
 * Returns "" when neither source is configured.
 *
 * The _FILE variant is preferred for deployed instances so the raw secret value
 * never appears in `systemctl show` output or process listings.
 */
function loadBearerToken(): string {
  const direct = process.env.SOCIAL_READER_MCP_HTTP_TOKEN;
  if (direct) return direct;

  const filePath = process.env.SOCIAL_READER_MCP_HTTP_TOKEN_FILE;
  if (filePath) {
    // Replace trailing whitespace — editors commonly append a newline.
    return readFileSync(filePath, "utf-8").replace(/\s+$/, "");
  }

  return "";
}

/**
 * Returns true for addresses that bind only to the local machine.
 * Used to decide whether a missing token is a fatal misconfiguration.
 * Exported for unit testing.
 */
export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Constant-time string comparison. Token length is not a secret (a wrong-length
 * token is always rejected), but the character comparison itself uses
 * timingSafeEqual so response time does not leak how many characters matched.
 * Exported for unit testing.
 */
export function tokenMatch(expected: string, provided: string): boolean {
  // timingSafeEqual requires equal-length Buffers; reject early on length mismatch.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf-8"), Buffer.from(provided, "utf-8"));
}

// ── Request helpers ───────────────────────────────────────────────────────────

/**
 * Accumulates the request body chunks and parses them as JSON.
 * Passing the parsed object to transport.handleRequest() as parsedBody lets the
 * SDK skip its own body-reading logic (which expects a Web Streams request body).
 */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Writes a 401 response and logs the rejection — never includes the token value. */
function send401(res: ServerResponse, sourceIp: string, path: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[social-reader-mcp] auth-rejected ts=${ts} ip=${sourceIp} path=${path}\n`);
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
}

// ── HTTP server ───────────────────────────────────────────────────────────────

/**
 * Creates and binds the HTTP MCP server.
 *
 * Returns a Promise that resolves once the server is listening. After that,
 * Node's active http.Server keeps the process alive — no keepalive loop needed.
 *
 * @param createConfiguredServer - Factory that returns a fully configured MCP
 *   Server with all tool handlers registered. Called once per POST /mcp request.
 *   Each call creates a new Server instance, but handler closures reference the
 *   module-level `clients` variable so all requests share the same social
 *   platform connections and cursor state file.
 */
export async function startHttpServer(
  createConfiguredServer: () => Server
): Promise<import("node:http").Server> {
  const host = process.env.SOCIAL_READER_MCP_HTTP_HOST ?? "127.0.0.1";
  const port = parseInt(process.env.SOCIAL_READER_MCP_HTTP_PORT ?? "8787", 10);
  const token = loadBearerToken();

  // Specific error when a non-loopback bind is attempted without a token —
  // this would expose the MCP server to the network with no authentication.
  if (!token && !isLoopback(host)) {
    process.stderr.write(
      `[social-reader-mcp] ERROR: SOCIAL_READER_MCP_HTTP_HOST="${host}" is a non-loopback address\n` +
        `  but no bearer token is configured. The server will not start without a token\n` +
        `  when bound to a network-facing address. Set SOCIAL_READER_MCP_HTTP_TOKEN or\n` +
        `  SOCIAL_READER_MCP_HTTP_TOKEN_FILE.\n`
    );
    process.exit(1);
  }

  // Generic error when no token is set, even for loopback — a missing token is
  // always a misconfiguration, not a valid "anonymous" mode.
  if (!token) {
    process.stderr.write(
      `[social-reader-mcp] ERROR: SOCIAL_READER_TRANSPORT=http requires a bearer token.\n` +
        `  Set SOCIAL_READER_MCP_HTTP_TOKEN (literal value in env) or\n` +
        `      SOCIAL_READER_MCP_HTTP_TOKEN_FILE (path to a file containing the token).\n`
    );
    process.exit(1);
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const sourceIp = req.socket.remoteAddress ?? "unknown";

    // ── Health check — no auth, returns no account data ──────────────────────
    if (method === "GET" && path === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // ── Bearer token check — applied before every other route ─────────────────
    // Extract the token from "Authorization: Bearer <token>".
    const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!tokenMatch(token, provided)) {
      send401(res, sourceIp, path);
      return;
    }

    // ── MCP endpoint ──────────────────────────────────────────────────────────
    if (method === "POST" && path === "/mcp") {
      // Stateless: create a fresh MCP server + transport for each request.
      // Both are discarded when the request completes. Handler closures over
      // module-level `clients` ensure they all share the same social platform
      // connections and cursor state without needing a shared Server instance.
      const mcpServer = createConfiguredServer();
      const transport = new StreamableHTTPServerTransport({
        // undefined sessionIdGenerator → stateless mode (no session headers or validation)
        sessionIdGenerator: undefined,
      });

      // Register cleanup before any awaits so it fires even if the client
      // drops the connection mid-request (SSE streams stay open after
      // handleRequest resolves, so res "close" is the reliable signal).
      res.on("close", () => {
        transport.close().catch(() => {});
      });

      try {
        await mcpServer.connect(transport);
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal server error" }));
        }
        process.stderr.write(
          `[social-reader-mcp] /mcp handler error: ${e instanceof Error ? e.message : String(e)}\n`
        );
      }
      return;
    }

    // ── Catch-all 404 — after auth, so callers know they reached the server ───
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.on("error", reject);
    httpServer.listen(port, host, () => {
      process.stderr.write(
        `[social-reader-mcp] HTTP transport listening on http://${host}:${port}/mcp\n`
      );
      resolve();
    });
  });

  // Return the underlying http.Server so callers (e.g. tests) can close it.
  return httpServer;
}
