import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { isExperimentSessionsEnabled } from "./flags.ts";

// Available slash commands for ACP adapter
// Note: Most commands are implemented via Droid's JSON-RPC API, but a few are implemented
// in the adapter itself (e.g. /context, /compress, /sessions).
export function getAvailableCommands(): AvailableCommand[] {
  const commands: AvailableCommand[] = [
    {
      name: "help",
      description: "Show available slash commands",
      input: null,
    },
    {
      name: "context",
      description: "Show token usage (context indicator) for this session",
      input: null,
    },
    {
      name: "compress",
      description: "Compress conversation history (summary + restart)",
      input: { hint: "[optional instructions]" },
    },
    {
      name: "compact",
      description: "Alias for /compress",
      input: { hint: "[optional instructions]" },
    },
    {
      name: "model",
      description: "Show or change the current model",
      input: { hint: "[model_id]" },
    },
    {
      name: "mode",
      description: "Show or change the autonomy mode (off|low|medium|high|spec)",
      input: { hint: "[mode]" },
    },
    {
      name: "config",
      description: "Show current session configuration",
      input: null,
    },
    {
      name: "status",
      description: "Show current session status",
      input: null,
    },
  ];

  if (isExperimentSessionsEnabled()) {
    commands.push({
      name: "sessions",
      description: "List or load previous sessions (local Droid history)",
      input: { hint: "[load <#|id_prefix|session_id>|all]" },
    });
  }

  return commands;
}
