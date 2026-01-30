#!/usr/bin/env node

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import { runAcp } from "./acp-agent.ts";

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

// Parse command line arguments
const enableExperimentSessions = process.argv.includes("--experiment-sessions");
const enableWebsearchProxy = process.argv.includes("--websearch-proxy");

const reasoningEffort = pickArgValue(process.argv, ["--reasoning-effort", "-r"]);
if (reasoningEffort) {
  process.env.DROID_ACP_REASONING_EFFORT = reasoningEffort;
}

if (enableExperimentSessions) {
  process.env.DROID_ACP_EXPERIMENT_SESSIONS = "1";
}

if (enableWebsearchProxy) {
  process.env.DROID_ACP_WEBSEARCH_NATIVE = "1";
}

// stream-jsonrpc mode with custom adapter
runAcp();

process.stdin.resume();
