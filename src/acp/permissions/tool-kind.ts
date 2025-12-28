import type { ToolKind } from "@agentclientprotocol/sdk";

export function toolKindFromToolName(toolName: string): ToolKind {
  switch (toolName) {
    case "Read":
    case "LS":
      return "read";
    case "Grep":
    case "Glob":
      return "search";
    case "Edit":
    case "Write":
      return "edit";
    case "Move":
      return "move";
    case "Delete":
      return "delete";
    case "Bash":
      return "execute";
    case "Fetch":
      return "fetch";
    default:
      return "other";
  }
}
