import type { AgentSideConnection, ToolKind } from "@agentclientprotocol/sdk";
import type { PermissionRequest } from "../../types.ts";
import type { Logger } from "../../utils.ts";
import type { Session } from "../session-types.ts";
import { buildPermissionToolCallContent } from "./content.ts";
import { decidePermission } from "./decide.ts";
import { toolCallRawInputForClient, formatPermissionToolCallTitle } from "./format.ts";
import { extractDroidPermissionOptions } from "./options.ts";
import { permissionLocationsFromRawInput } from "./paths.ts";
import { extractSpecTitleAndPlan } from "./spec.ts";
import { toolKindFromToolName } from "./tool-kind.ts";

export async function handlePermission(
  ctx: {
    client: AgentSideConnection;
    logger: Logger;
    sendAgentMessage: (session: Session, text: string) => Promise<void>;
  },
  session: Session,
  params: PermissionRequest,
): Promise<{ selectedOption: string }> {
  const toolUse = params.toolUses?.[0]?.toolUse;
  if (!toolUse) {
    return { selectedOption: "proceed_once" };
  }

  const toolCallId = toolUse.id;
  const toolName = toolUse.name;
  const rawInput = toolUse.input;
  const spec = toolName === "ExitSpecMode" ? extractSpecTitleAndPlan(rawInput) : null;
  const command =
    typeof rawInput?.command === "string"
      ? rawInput.command
      : toolName === "ExitSpecMode" && typeof spec?.title === "string"
        ? spec.title
        : JSON.stringify(rawInput);
  const commandSummary = command.length > 200 ? command.slice(0, 200) + "…" : command;
  const isReadOnlyTool =
    toolName === "Read" || toolName === "Grep" || toolName === "Glob" || toolName === "LS";
  const riskLevelRaw = (rawInput as { riskLevel?: unknown } | null | undefined)?.riskLevel;
  const riskLevel =
    riskLevelRaw === "low" || riskLevelRaw === "medium" || riskLevelRaw === "high"
      ? riskLevelRaw
      : isReadOnlyTool
        ? "low"
        : "medium";

  ctx.logger.log(
    "Permission request for tool:",
    toolCallId,
    "risk:",
    riskLevel,
    "mode:",
    session.mode,
  );

  const toolCallTitle =
    toolName === "ExitSpecMode"
      ? spec?.title
        ? `Exit spec mode: ${spec.title}`
        : "Exit spec mode"
      : formatPermissionToolCallTitle({
          toolName,
          riskLevel,
          rawInput,
          cwd: session.cwd,
        });

  const toolCallKind: ToolKind =
    toolName === "ExitSpecMode" ? "switch_mode" : toolKindFromToolName(toolName);

  const toolCallLocations = permissionLocationsFromRawInput({
    toolName,
    rawInput,
    cwd: session.cwd,
  });

  const toolCallContent = await buildPermissionToolCallContent({
    toolName,
    riskLevel,
    rawInput,
    cwd: session.cwd,
    planMarkdown: toolName === "ExitSpecMode" ? (spec?.plan ?? null) : null,
  });

  // Emit tool_call (pending), de-duping if the tool call was already created from a tool_use block.
  const alreadyTracked = session.activeToolCallIds.has(toolCallId);
  session.activeToolCallIds.add(toolCallId);
  session.toolNames.set(toolCallId, toolName);
  session.toolCallStatus.set(toolCallId, "pending");
  session.toolCallRawInputById.set(toolCallId, rawInput);
  session.toolCallContentById.set(toolCallId, toolCallContent);
  const rawInputForClient = toolCallRawInputForClient(rawInput);

  if (alreadyTracked) {
    void ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: toolCallTitle,
        status: "pending",
        kind: toolCallKind,
        content: toolCallContent,
        locations: toolCallLocations,
        rawInput: rawInputForClient,
      },
    });
  } else {
    void ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: toolCallTitle,
        status: "pending",
        kind: toolCallKind,
        content: toolCallContent,
        locations: toolCallLocations,
        rawInput: rawInputForClient,
      },
    });
  }

  return decidePermission(
    {
      client: ctx.client,
      logger: ctx.logger,
      sendAgentMessage: ctx.sendAgentMessage,
    },
    session,
    {
      toolCallId,
      toolName,
      toolCallTitle,
      command: commandSummary,
      riskLevel,
      rawInput,
      toolCallKind,
      toolCallContent,
      toolCallLocations,
      droidOptions: extractDroidPermissionOptions(params),
    },
  );
}
