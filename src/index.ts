#!/usr/bin/env node

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { spawn } from "node:child_process";
import { runAcp } from "./acp-agent.ts";
import { findDroidExecutable, isEnvEnabled, isWindows } from "./utils.ts";
import { startWebsearchProxy, type WebsearchProxyHandle } from "./websearch-proxy.ts";

function pickArgValue(argv: string[], names: string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    for (const name of names) {
      if (arg === name) {
        const next = argv[i + 1] ?? "";
        if (!next || next.startsWith("-")) return null;
        return next;
      }
      if (arg.startsWith(`${name}=`)) {
        const value = arg.slice(`${name}=`.length);
        return value.length > 0 ? value : null;
      }
    }
  }
  return null;
}

/**
 * Run droid with native ACP mode (--output-format acp).
 * Note: Native ACP mode does NOT support custom models due to a bug in droid.
 */
function runNativeAcp(): void {
  const executable = findDroidExecutable();
  const cwd = process.cwd();
  const args = ["exec", "--output-format", "acp", "--cwd", cwd];

  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };

  const reasoningEffort = env.DROID_ACP_REASONING_EFFORT;
  if (typeof reasoningEffort === "string" && reasoningEffort.trim().length > 0) {
    args.push("--reasoning-effort", reasoningEffort.trim());
  }

  console.error(`[droid-acp] Starting droid with native ACP: ${executable} ${args.join(" ")}`);
  console.error("[droid-acp] WARNING: Native ACP mode does not support custom models!");

  let websearchProxy: WebsearchProxyHandle | null = null;
  const stopWebsearchProxy = () => {
    if (!websearchProxy) return;
    const proxy = websearchProxy;
    websearchProxy = null;
    proxy.close().catch((err: unknown) => {
      console.error("[droid-acp] Failed to close websearch proxy:", err);
    });
  };

  const startWebsearchProxyIfEnabled = async () => {
    const hasExplicitToggle = typeof env.DROID_ACP_WEBSEARCH === "string";
    const smitheryConfigured =
      typeof env.SMITHERY_API_KEY === "string" &&
      env.SMITHERY_API_KEY.trim().length > 0 &&
      typeof env.SMITHERY_PROFILE === "string" &&
      env.SMITHERY_PROFILE.trim().length > 0;
    const forwardConfigured =
      typeof env.DROID_ACP_WEBSEARCH_FORWARD_URL === "string" &&
      env.DROID_ACP_WEBSEARCH_FORWARD_URL.trim().length > 0;

    const enableWebsearchProxy = hasExplicitToggle
      ? isEnvEnabled(env.DROID_ACP_WEBSEARCH)
      : smitheryConfigured || forwardConfigured;

    if (!enableWebsearchProxy) return;

    const upstreamBaseUrl =
      env.DROID_ACP_WEBSEARCH_UPSTREAM_URL ??
      env.FACTORY_API_BASE_URL_OVERRIDE ??
      "https://api.factory.ai";

    const forwardModeRaw = env.DROID_ACP_WEBSEARCH_FORWARD_MODE;

    const forwardUrlRaw =
      typeof env.DROID_ACP_WEBSEARCH_FORWARD_URL === "string"
        ? env.DROID_ACP_WEBSEARCH_FORWARD_URL.trim()
        : "";
    const forwardPrefixMatch = forwardUrlRaw.match(/^mcp:(.*)$/i);
    const websearchForwardUrl = forwardUrlRaw.length > 0 ? forwardUrlRaw : undefined;
    const forwardModeNormalized =
      typeof forwardModeRaw === "string" ? forwardModeRaw.trim().toLowerCase() : "";
    const websearchForwardMode =
      forwardModeNormalized === "mcp"
        ? ("mcp" as const)
        : forwardModeNormalized === "http"
          ? ("http" as const)
          : forwardPrefixMatch
            ? ("mcp" as const)
            : ("http" as const);

    const host = env.DROID_ACP_WEBSEARCH_HOST ?? "127.0.0.1";

    const portRaw = env.DROID_ACP_WEBSEARCH_PORT;
    let port: number | undefined;
    if (typeof portRaw === "string" && portRaw.length > 0) {
      const parsed = Number.parseInt(portRaw, 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
        throw new Error(`Invalid DROID_ACP_WEBSEARCH_PORT: ${portRaw}`);
      }
      port = parsed;
    }

    websearchProxy = await startWebsearchProxy({
      upstreamBaseUrl,
      websearchForwardUrl: forwardPrefixMatch ? forwardPrefixMatch[1]?.trim() : websearchForwardUrl,
      websearchForwardMode,
      smitheryApiKey: env.SMITHERY_API_KEY,
      smitheryProfile: env.SMITHERY_PROFILE,
      host,
      port,
      logger: console,
    });

    // Droid requires an auth header for tool calls (including websearch) and will error early if missing.
    // Since websearch is intercepted by the local proxy, any non-empty value is sufficient here.
    if (!env.FACTORY_API_KEY) {
      env.FACTORY_API_KEY = "droid-acp-websearch";
    }

    env.FACTORY_API_BASE_URL_OVERRIDE = websearchProxy.baseUrl;
    env.FACTORY_API_BASE_URL = websearchProxy.baseUrl;
  };

  startWebsearchProxyIfEnabled()
    .then(() => {
      const droid = spawn(executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        // Windows requires shell: true for proper command execution
        shell: isWindows,
        // Windows-specific: hide the console window
        windowsHide: true,
      });

      process.stdin.pipe(droid.stdin);
      droid.stdout.pipe(process.stdout);
      droid.stderr.on("data", (data: Buffer) => {
        console.error(`[droid stderr] ${data.toString().trim()}`);
      });

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        stopWebsearchProxy();
        try {
          droid.stdin?.end();
        } catch {}
        try {
          droid.kill("SIGTERM");
        } catch {}
      };

      droid.on("error", (err) => {
        console.error("[droid-acp] Failed to start droid:", err.message);
        cleanup();
        process.exit(1);
      });

      droid.on("exit", (code, signal) => {
        console.error(`[droid-acp] Droid exited with code ${code}, signal ${signal}`);
        cleanup();
        process.exit(code ?? 0);
      });

      // Signal handling (works on Unix, limited on Windows)
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      if (isWindows) {
        process.on("SIGBREAK", cleanup);
      } else {
        process.on("SIGHUP", cleanup);
      }
      process.on("exit", cleanup);
    })
    .catch((err: unknown) => {
      console.error("[droid-acp] Failed to start websearch proxy:", err);
      stopWebsearchProxy();
      process.exit(1);
    });
}

// Parse command line arguments
const useNativeAcp = process.argv.includes("--acp");
const enableExperimentSessions = process.argv.includes("--experiment-sessions");

const reasoningEffort = pickArgValue(process.argv, ["--reasoning-effort", "-r"]);
if (reasoningEffort) {
  process.env.DROID_ACP_REASONING_EFFORT = reasoningEffort;
}

if (enableExperimentSessions) {
  process.env.DROID_ACP_EXPERIMENT_SESSIONS = "1";
}

if (useNativeAcp) {
  // Native ACP mode: direct pipe to droid (no custom model support)
  runNativeAcp();
} else {
  // Default: stream-jsonrpc mode with custom adapter (supports custom models)
  runAcp();
}

process.stdin.resume();
