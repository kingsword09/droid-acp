import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./utils.ts";

function parseSseJsonPayload(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  let currentData: string[] = [];
  const flush = (acc: unknown[]): void => {
    if (currentData.length === 0) return;
    const joined = currentData.join("\n");
    try {
      acc.push(JSON.parse(joined));
    } catch {
      // Ignore non-JSON events.
    }
    currentData = [];
  };

  const parsed: unknown[] = [];
  for (const line of lines) {
    if (line.length === 0) {
      flush(parsed);
      continue;
    }

    if (line.startsWith("event:")) {
      continue;
    }

    if (line.startsWith("data:")) {
      const data = line.slice("data:".length).replace(/^ /, "");
      currentData.push(data);
      continue;
    }

    // Ignore other SSE fields.
  }
  flush(parsed);

  // Prefer the last JSON payload (often the final message).
  return parsed.length > 0 ? parsed[parsed.length - 1] : null;
}

export interface WebsearchProxyOptions {
  upstreamBaseUrl: string;
  websearchForwardUrl?: string;
  websearchForwardMode?: "http" | "mcp";
  smitheryApiKey?: string;
  smitheryProfile?: string;
  host?: string;
  port?: number;
  logger?: Logger;
}

export interface WebsearchProxyHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

function parseHttpUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must be http(s): ${value}`);
  }

  return url;
}

function resolveForwardTarget(forward: URL, requestPathAndQuery: string): URL {
  // If the forward URL looks like a base (no explicit path), keep the request path.
  if (forward.pathname === "/" && forward.search === "" && forward.hash === "") {
    return new URL(requestPathAndQuery, forward);
  }

  // Otherwise treat it as a full URL, but preserve the query string if caller didn't set one.
  const target = new URL(forward.toString());
  if (!target.search && requestPathAndQuery.includes("?")) {
    target.search = requestPathAndQuery.slice(requestPathAndQuery.indexOf("?"));
  }
  return target;
}

function isBodylessMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseWebsearchRequestBody(
  bodyBuffer: Buffer,
): { query: string; numResults: number } | null {
  let input: unknown;
  try {
    input = JSON.parse(bodyBuffer.toString("utf8"));
  } catch {
    return null;
  }

  const query = toNonEmptyString((input as { query?: unknown } | null | undefined)?.query);
  if (!query) return null;

  const numResultsRaw = (input as { numResults?: unknown } | null | undefined)?.numResults;
  const numResults =
    typeof numResultsRaw === "number" && Number.isFinite(numResultsRaw)
      ? Math.max(1, numResultsRaw)
      : 10;

  return { query, numResults };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error(`Request body too large (${total} bytes)`);
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}

function parseSearchResultsText(
  text: string,
  numResults: number,
): Array<Record<string, unknown>> | null {
  // First try JSON (some MCP servers return an array encoded in text).
  try {
    const json = JSON.parse(text) as unknown;
    if (Array.isArray(json)) return (json as Array<Record<string, unknown>>).slice(0, numResults);
  } catch {
    // Fall through to plain-text parsing.
  }

  // Fallback: Smithery Exa MCP often returns plain text blocks:
  // Title: ...
  // URL: ...
  // Text: ...
  const matches = [...text.matchAll(/^Title:\s*(.*)$/gm)];
  if (matches.length === 0) return null;

  const results: Array<Record<string, unknown>> = [];
  for (let i = 0; i < matches.length && results.length < numResults; i += 1) {
    const start = matches[i]?.index ?? 0;
    const end = matches[i + 1]?.index ?? text.length;
    const chunk = text.slice(start, end).trim();
    const title = matches[i]?.[1]?.trim() ?? "";
    const url = (chunk.match(/^URL:\s*(.*)$/m)?.[1] ?? "").trim();
    const snippet = (chunk.match(/^Text:\s*(.*)$/m)?.[1] ?? "").trim();
    results.push({ title, url, snippet, text: snippet });
  }

  return results;
}

async function tryHandleWebsearchWithMcp(
  res: ServerResponse,
  logger: Logger,
  mcpEndpoint: URL,
  bodyBuffer: Buffer,
): Promise<{ handled: boolean; error?: string }> {
  const parsed = parseWebsearchRequestBody(bodyBuffer);
  if (!parsed) return { handled: false };
  const { query, numResults } = parsed;

  const requestBody = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        numResults,
      },
    },
  };

  let mcpResponse: unknown;
  try {
    const response = await fetch(mcpEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Smithery requires the client to accept both JSON and SSE.
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(requestBody),
    });

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      const raw = await response.text();
      const parsedSse = parseSseJsonPayload(raw);
      if (!parsedSse) {
        throw new Error("Invalid MCP SSE response: missing JSON payload");
      }
      mcpResponse = parsedSse;
    } else {
      mcpResponse = await response.json();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[websearch] MCP request failed:", message);
    return { handled: false, error: message };
  }

  const resultContent = (mcpResponse as { result?: { content?: unknown } } | null | undefined)
    ?.result?.content;
  const contentBlocks = Array.isArray(resultContent) ? (resultContent as Array<unknown>) : [];
  const textBlock = contentBlocks.find(
    (c): c is { type: string; text: string } =>
      !!c &&
      typeof c === "object" &&
      (c as { type?: unknown }).type === "text" &&
      typeof (c as { text?: unknown }).text === "string",
  );

  if (!textBlock) {
    const errorMessage =
      (mcpResponse as { error?: { message?: unknown } } | null | undefined)?.error?.message ??
      (mcpResponse as { error?: unknown } | null | undefined)?.error ??
      null;
    const message =
      typeof errorMessage === "string"
        ? errorMessage
        : `Invalid MCP response: ${JSON.stringify(mcpResponse)}`;
    logger.error("[websearch] MCP response missing text content:", message);
    return { handled: false, error: message };
  }

  const parsedItems = parseSearchResultsText(textBlock.text, numResults);
  if (!parsedItems) {
    logger.error("[websearch] Failed to parse MCP text payload");
    return { handled: false, error: "Invalid MCP payload: unsupported format" };
  }

  const results = parsedItems.slice(0, numResults).map((item) => {
    const title = toNonEmptyString(item.title) ?? "";
    const url = toNonEmptyString(item.url) ?? "";
    const highlights = Array.isArray(item.highlights)
      ? (item.highlights as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const content =
      toNonEmptyString(item.text) ??
      toNonEmptyString(item.snippet) ??
      (highlights.length > 0 ? highlights.join(" ") : "");

    return {
      title,
      url,
      content,
      snippet: content,
      publishedDate: item.publishedDate ?? null,
      author: item.author ?? null,
      score: item.score ?? null,
    };
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ results }));
  return { handled: true };
}

export async function startWebsearchProxy(
  options: WebsearchProxyOptions,
): Promise<WebsearchProxyHandle> {
  const logger = options.logger ?? console;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;

  const upstreamBase = parseHttpUrl(options.upstreamBaseUrl, "DROID_ACP_WEBSEARCH_UPSTREAM_URL");
  const forward = options.websearchForwardUrl
    ? parseHttpUrl(options.websearchForwardUrl, "DROID_ACP_WEBSEARCH_FORWARD_URL")
    : null;
  const forwardMode = options.websearchForwardMode ?? "http";

  const smitheryApiKey = toNonEmptyString(options.smitheryApiKey);
  const smitheryProfile = toNonEmptyString(options.smitheryProfile);
  const smitheryEndpoint =
    smitheryApiKey && smitheryProfile
      ? new URL(
          `https://server.smithery.ai/exa/mcp?api_key=${encodeURIComponent(
            smitheryApiKey,
          )}&profile=${encodeURIComponent(smitheryProfile)}`,
        )
      : null;

  let totalRequests = 0;
  let websearchRequests = 0;
  let lastWebsearchAt: string | null = null;
  let lastWebsearchOutcome: string | null = null;

  const server = createServer((req, res) => {
    void (async () => {
      totalRequests += 1;
      const rawUrl = req.url;
      if (!rawUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing URL" }));
        return;
      }

      const requestUrl = new URL(rawUrl, `http://${req.headers.host ?? "127.0.0.1"}`);
      const pathAndQuery = `${requestUrl.pathname}${requestUrl.search || ""}`;

      if (requestUrl.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            upstreamBaseUrl: upstreamBase.toString(),
            websearchForwardUrl: forward?.toString() ?? null,
            websearchForwardMode: forwardMode,
            smitheryEnabled: Boolean(smitheryEndpoint),
            requests: {
              total: totalRequests,
              websearch: websearchRequests,
              lastWebsearchAt,
              lastWebsearchOutcome,
            },
          }),
        );
        return;
      }

      const isWebsearchPath = requestUrl.pathname.startsWith("/api/tools/exa/search");
      const isWebsearch = isWebsearchPath && req.method === "POST";
      const shouldUseForwardForWebsearch = isWebsearch && forward && forwardMode === "http";
      const targetUrl = shouldUseForwardForWebsearch
        ? resolveForwardTarget(forward, pathAndQuery)
        : new URL(pathAndQuery, upstreamBase);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === "host") continue;
        // Avoid forwarding compression negotiation headers. Node fetch may transparently decompress,
        // which can lead to clients attempting a second decompression pass.
        if (key.toLowerCase() === "accept-encoding") continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      headers.set("accept-encoding", "identity");

      const controller = new AbortController();
      req.on("aborted", () => controller.abort());

      let bodyBuffer: Buffer | null = null;
      if (isWebsearch) {
        websearchRequests += 1;
        lastWebsearchAt = new Date().toISOString();
        try {
          bodyBuffer = await readBody(req, 1_000_000);
        } catch {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Request body too large" }));
          lastWebsearchOutcome = "rejected: body too large";
          return;
        }

        // Mode 1: forward as MCP to a custom MCP endpoint.
        if (forward && forwardMode === "mcp") {
          const r = await tryHandleWebsearchWithMcp(res, logger, forward, bodyBuffer);
          if (r.handled) {
            lastWebsearchOutcome = "handled: mcp forward";
            return;
          }
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "WebSearch MCP forward failed",
              message: r.error ?? "Unknown error",
            }),
          );
          lastWebsearchOutcome = `error: mcp forward (${r.error ?? "unknown"})`;
          return;
        }

        // Mode 2: Smithery Exa MCP (env-driven), compatible with droid-patch.
        if (smitheryEndpoint) {
          const r = await tryHandleWebsearchWithMcp(res, logger, smitheryEndpoint, bodyBuffer);
          if (r.handled) {
            lastWebsearchOutcome = "handled: smithery exa mcp";
            return;
          }
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Smithery Exa MCP websearch failed",
              message: r.error ?? "Unknown error",
            }),
          );
          lastWebsearchOutcome = `error: smithery exa mcp (${r.error ?? "unknown"})`;
          return;
        }

        logger.log("[websearch] proxying", pathAndQuery, "->", targetUrl.toString());
        lastWebsearchOutcome = "proxied: upstream";
      } else {
        logger.log("[factory-proxy]", req.method ?? "GET", pathAndQuery);
      }

      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(targetUrl, {
          method: req.method,
          headers,
          body: isBodylessMethod(req.method) ? undefined : bodyBuffer ? bodyBuffer : req,
          redirect: "manual",
          signal: controller.signal,
          // Required by undici when streaming request bodies.
          duplex: "half",
        } as RequestInit);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Upstream request failed", message }));
        return;
      }

      const setCookie: string[] | undefined = (
        upstreamResponse.headers as unknown as {
          getSetCookie?: () => string[];
        }
      ).getSetCookie?.();
      if (setCookie && setCookie.length > 0) {
        res.setHeader("set-cookie", setCookie);
      }

      for (const [key, value] of upstreamResponse.headers) {
        if (key.toLowerCase() === "set-cookie") continue;
        if (key.toLowerCase() === "content-encoding") continue;
        if (key.toLowerCase() === "content-length") continue;
        res.setHeader(key, value);
      }

      res.statusCode = upstreamResponse.status;

      if (!upstreamResponse.body) {
        res.end();
        return;
      }

      try {
        await pipeline(Readable.fromWeb(upstreamResponse.body), res);
      } catch {
        // Connection ended; nothing to do.
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to bind websearch proxy server");
  }
  const actualPort = (address as AddressInfo).port;
  const baseUrl = `http://${host}:${actualPort}`;

  logger.log("[websearch] proxy listening on", baseUrl);

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
