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
import { findDroidExecutable, isWindows } from "./utils.ts";

/**
 * Run droid with native ACP mode (--output-format acp).
 * Note: Native ACP mode does NOT support custom models due to a bug in droid.
 */
function runNativeAcp(): void {
  const executable = findDroidExecutable();
  const cwd = process.cwd();
  const args = ["exec", "--output-format", "acp", "--cwd", cwd];

  console.error(`[droid-acp] Starting droid with native ACP: ${executable} ${args.join(" ")}`);
  console.error("[droid-acp] WARNING: Native ACP mode does not support custom models!");

  const droid = spawn(executable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
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

  droid.on("error", (err) => {
    console.error("[droid-acp] Failed to start droid:", err.message);
    process.exit(1);
  });

  droid.on("exit", (code, signal) => {
    console.error(`[droid-acp] Droid exited with code ${code}, signal ${signal}`);
    process.exit(code ?? 0);
  });

  // Signal handling (works on Unix, limited on Windows)
  process.on("SIGTERM", () => droid.kill());
  process.on("SIGINT", () => droid.kill());
  if (isWindows) {
    process.on("SIGHUP", () => droid.kill());
  }
}

// Parse command line arguments
const useNativeAcp = process.argv.includes("--acp");

if (useNativeAcp) {
  // Native ACP mode: direct pipe to droid (no custom model support)
  runNativeAcp();
} else {
  // Default: stream-jsonrpc mode with custom adapter (supports custom models)
  runAcp();
}

process.stdin.resume();
