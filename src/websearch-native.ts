/**
 * WebSearch Native Provider Mode (experimental)
 *
 * Uses model's native websearch capability based on ~/.factory/settings.json configuration.
 * Supported providers:
 * - Anthropic: web_search_20250305 server tool
 * - OpenAI: web_search tool via /responses endpoint
 */

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "./utils.ts";

export interface NativeWebsearchProxyOptions {
  factoryApiUrl?: string;
  host?: string;
  port?: number;
  logger?: Logger;
}

export interface NativeWebsearchProxyHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

interface ModelConfig {
  id: string;
  displayName?: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface FactorySettings {
  sessionDefaultSettings?: {
    model?: string;
  };
  customModels?: ModelConfig[];
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

let cachedSettings: FactorySettings | null = null;
let settingsLastModified = 0;

function getFactorySettings(logger: Logger): FactorySettings | null {
  const settingsPath = join(homedir(), ".factory", "settings.json");
  try {
    const stats = statSync(settingsPath);
    if (cachedSettings && stats.mtimeMs === settingsLastModified) {
      return cachedSettings;
    }
    cachedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as FactorySettings;
    settingsLastModified = stats.mtimeMs;
    return cachedSettings;
  } catch (e) {
    logger.error("[websearch-native] Failed to load settings.json:", (e as Error).message);
    return null;
  }
}

function getCurrentModelConfig(logger: Logger): ModelConfig | null {
  const settings = getFactorySettings(logger);
  if (!settings) return null;

  const currentModelId = settings.sessionDefaultSettings?.model;
  if (!currentModelId) return null;

  const customModels = settings.customModels || [];
  const modelConfig = customModels.find((m) => m.id === currentModelId);

  if (modelConfig) {
    logger.log(
      "[websearch-native] Model:",
      modelConfig.displayName || modelConfig.id,
      "| Provider:",
      modelConfig.provider,
    );
    return modelConfig;
  }

  if (!currentModelId.startsWith("custom:")) return null;
  logger.log("[websearch-native] Model not found:", currentModelId);
  return null;
}

async function searchAnthropicNative(
  query: string,
  numResults: number,
  modelConfig: ModelConfig,
  logger: Logger,
): Promise<SearchResult[] | null> {
  const { baseUrl, apiKey, model } = modelConfig;

  try {
    const requestBody = {
      model: model,
      max_tokens: 4096,
      stream: false,
      system:
        "You are a web search assistant. Use the web_search tool to find relevant information and return the results.",
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      tool_choice: { type: "tool", name: "web_search" },
      messages: [
        {
          role: "user",
          content: `Search the web for: ${query}\n\nReturn up to ${numResults} relevant results.`,
        },
      ],
    };

    let endpoint = baseUrl;
    if (!endpoint.endsWith("/v1/messages")) {
      endpoint = endpoint.replace(/\/$/, "") + "/v1/messages";
    }

    logger.log("[websearch-native] Anthropic search:", query, "→", endpoint);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });

    const data = (await response.json()) as {
      error?: { message?: string };
      content?: Array<{
        type: string;
        content?: Array<{
          type: string;
          title?: string;
          url?: string;
          snippet?: string;
          page_content?: string;
        }>;
      }>;
    };

    if (data.error) {
      logger.error("[websearch-native] Anthropic API error:", data.error.message);
      return null;
    }

    const results: SearchResult[] = [];
    for (const block of data.content || []) {
      if (block.type === "web_search_tool_result") {
        for (const result of block.content || []) {
          if (result.type === "web_search_result") {
            results.push({
              title: result.title || "",
              url: result.url || "",
              content: result.snippet || result.page_content || "",
            });
          }
        }
      }
    }

    logger.log("[websearch-native] Anthropic results:", results.length);
    return results.length > 0 ? results.slice(0, numResults) : null;
  } catch (e) {
    logger.error("[websearch-native] Anthropic error:", (e as Error).message);
    return null;
  }
}

async function searchOpenAINative(
  query: string,
  numResults: number,
  modelConfig: ModelConfig,
  logger: Logger,
): Promise<SearchResult[] | null> {
  const { baseUrl, apiKey, model } = modelConfig;

  try {
    const requestBody = {
      model: model,
      stream: false,
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      input: `Search the web for: ${query}\n\nReturn up to ${numResults} relevant results.`,
    };

    let endpoint = baseUrl;
    if (!endpoint.endsWith("/responses")) {
      endpoint = endpoint.replace(/\/$/, "") + "/responses";
    }

    logger.log("[websearch-native] OpenAI search:", query, "→", endpoint);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = (await response.json()) as {
      error?: { message?: string };
      output?: Array<{
        type: string;
        content?: Array<{
          type: string;
          annotations?: Array<{
            type: string;
            url?: string;
            title?: string;
          }>;
        }>;
      }>;
    };

    if (data.error) {
      logger.error("[websearch-native] OpenAI API error:", data.error.message);
      return null;
    }

    const results: SearchResult[] = [];
    for (const item of data.output || []) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === "output_text" && Array.isArray(content.annotations)) {
            for (const annotation of content.annotations) {
              if (annotation.type === "url_citation" && annotation.url) {
                results.push({
                  title: annotation.title || "",
                  url: annotation.url || "",
                  content: annotation.title || "",
                });
              }
            }
          }
        }
      }
    }

    logger.log("[websearch-native] OpenAI results:", results.length);
    return results.length > 0 ? results.slice(0, numResults) : null;
  } catch (e) {
    logger.error("[websearch-native] OpenAI error:", (e as Error).message);
    return null;
  }
}

async function search(
  query: string,
  numResults: number,
  logger: Logger,
): Promise<{ results: SearchResult[]; source: string }> {
  logger.log("[websearch-native] Search:", query);

  const modelConfig = getCurrentModelConfig(logger);
  if (!modelConfig) {
    logger.log("[websearch-native] No custom model configured");
    return { results: [], source: "none" };
  }

  const provider = modelConfig.provider;
  let results: SearchResult[] | null = null;

  if (provider === "anthropic") {
    results = await searchAnthropicNative(query, numResults, modelConfig, logger);
  } else if (provider === "openai") {
    results = await searchOpenAINative(query, numResults, modelConfig, logger);
  } else {
    logger.log("[websearch-native] Unsupported provider:", provider);
  }

  if (results && results.length > 0) {
    return { results, source: `native-${provider}` };
  }
  return { results: [], source: "none" };
}

function parseRequestBody(body: string): { query: string; numResults: number } | null {
  try {
    const parsed = JSON.parse(body) as { query?: string; numResults?: number };
    const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    if (!query) return null;
    const numResults =
      typeof parsed.numResults === "number" && Number.isFinite(parsed.numResults)
        ? Math.max(1, parsed.numResults)
        : 10;
    return { query, numResults };
  } catch {
    return null;
  }
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
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

  return Buffer.concat(chunks).toString("utf-8");
}

export async function startNativeWebsearchProxy(
  options: NativeWebsearchProxyOptions,
): Promise<NativeWebsearchProxyHandle> {
  const logger = options.logger ?? console;
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const factoryApiUrl = options.factoryApiUrl ?? "https://api.factory.ai";

  let totalRequests = 0;
  let websearchRequests = 0;
  let lastWebsearchAt: string | null = null;
  let lastWebsearchSource: string | null = null;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      totalRequests += 1;
      const rawUrl = req.url;
      if (!rawUrl) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing URL" }));
        return;
      }

      const requestUrl = new URL(rawUrl, `http://${req.headers.host ?? "127.0.0.1"}`);

      if (requestUrl.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            mode: "native-provider",
            requests: {
              total: totalRequests,
              websearch: websearchRequests,
              lastWebsearchAt,
              lastWebsearchSource,
            },
          }),
        );
        return;
      }

      if (requestUrl.pathname === "/api/tools/exa/search" && req.method === "POST") {
        websearchRequests += 1;
        lastWebsearchAt = new Date().toISOString();

        try {
          const body = await readBody(req, 1_000_000);
          const parsed = parseRequestBody(body);

          if (!parsed) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid request body", results: [] }));
            return;
          }

          const result = await search(parsed.query, parsed.numResults, logger);
          lastWebsearchSource = result.source;
          logger.log("[websearch-native] Results:", result.results.length, "from", result.source);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results: result.results }));
        } catch (e) {
          logger.error("[websearch-native] Search error:", (e as Error).message);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(e), results: [] }));
        }
        return;
      }

      // Proxy other requests to Factory API
      const pathAndQuery = `${requestUrl.pathname}${requestUrl.search || ""}`;
      const targetUrl = new URL(pathAndQuery, factoryApiUrl);

      logger.log("[websearch-native] Proxy:", req.method ?? "GET", pathAndQuery);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === "host") continue;
        if (key.toLowerCase() === "accept-encoding") continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      headers.set("accept-encoding", "identity");

      try {
        let body: string | undefined;
        if (req.method !== "GET" && req.method !== "HEAD") {
          body = await readBody(req, 10_000_000);
        }

        const response = await fetch(targetUrl, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
        });

        for (const [key, value] of response.headers) {
          if (key.toLowerCase() === "content-encoding") continue;
          if (key.toLowerCase() === "content-length") continue;
          res.setHeader(key, value);
        }
        res.statusCode = response.status;

        if (!response.body) {
          res.end();
          return;
        }

        const arrayBuffer = await response.arrayBuffer();
        res.end(Buffer.from(arrayBuffer));
      } catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Proxy failed: " + (e as Error).message }));
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
    throw new Error("Failed to bind native websearch proxy server");
  }
  const actualPort = (address as AddressInfo).port;
  const baseUrl = `http://${host}:${actualPort}`;

  logger.log("[websearch-native] proxy listening on", baseUrl);

  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
