import type { ToolCallContent } from "@agentclientprotocol/sdk";
import { buildPermissionDiffContent } from "./diff.ts";
import { formatPermissionDetailsMarkdown } from "./format.ts";

export async function buildPermissionToolCallContent(params: {
  toolName: string;
  riskLevel: "low" | "medium" | "high";
  rawInput: unknown;
  cwd: string;
  planMarkdown: string | null;
}): Promise<ToolCallContent[]> {
  if (params.toolName === "ExitSpecMode" && params.planMarkdown) {
    return [
      {
        type: "content",
        content: { type: "text", text: params.planMarkdown },
      },
    ];
  }

  const content: ToolCallContent[] = [];
  const diff = await buildPermissionDiffContent({
    toolName: params.toolName,
    rawInput: params.rawInput,
    cwd: params.cwd,
  });
  if (diff) content.push(diff);

  content.push({
    type: "content",
    content: {
      type: "text",
      text: formatPermissionDetailsMarkdown({
        toolName: params.toolName,
        riskLevel: params.riskLevel,
        rawInput: params.rawInput,
      }),
    },
  });

  return content;
}
