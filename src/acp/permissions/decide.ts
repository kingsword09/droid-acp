import type {
  AgentSideConnection,
  PermissionOption,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { DroidPermissionOption } from "../../types.ts";
import type { Logger } from "../../utils.ts";
import type { Session } from "../session-types.ts";
import { toolCallRawInputForClient } from "./format.ts";
import { buildAcpPermissionOptions, permissionKindFromOptionValue } from "./acp-options.ts";
import { mapExitSpecModeSelection } from "./options.ts";
import { computeAutoDecision } from "./auto-decision.ts";
import { extractSpecTitleAndPlan } from "./spec.ts";
import { emitExitSpecModePlanUpdate, maybeHandleExitSpecModePlanChoice } from "./exit-spec.ts";

export async function decidePermission(
  ctx: {
    client: AgentSideConnection;
    logger: Logger;
    sendAgentMessage: (session: Session, text: string) => Promise<void>;
  },
  session: Session,
  params: {
    toolCallId: string;
    toolName: string;
    toolCallTitle: string;
    command: string;
    riskLevel: "low" | "medium" | "high";
    rawInput: unknown;
    toolCallKind: ToolKind;
    toolCallContent: ToolCallContent[];
    toolCallLocations: ToolCallLocation[] | undefined;
    droidOptions: DroidPermissionOption[] | null;
  },
): Promise<{ selectedOption: string }> {
  if (session.cancelled) {
    session.toolCallStatus.set(params.toolCallId, "completed");
    session.activeToolCallIds.delete(params.toolCallId);
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status: "completed",
      },
    });
    return { selectedOption: "cancel" };
  }

  const droidOptions = params.droidOptions?.length ? params.droidOptions : null;
  const acpOptions: PermissionOption[] = buildAcpPermissionOptions({
    toolName: params.toolName,
    droidOptions,
  });

  const spec = extractSpecTitleAndPlan(params.rawInput);
  const planTitle = spec.title;
  const planMarkdown = spec.plan;

  if (params.toolName === "ExitSpecMode" && planMarkdown) {
    const early = await maybeHandleExitSpecModePlanChoice(
      { client: ctx.client, sendAgentMessage: ctx.sendAgentMessage },
      session,
      { toolCallId: params.toolCallId, planTitle, planMarkdown },
    );
    if (early) return early;
  }

  if (params.toolName === "ExitSpecMode" && planMarkdown) {
    await emitExitSpecModePlanUpdate({ client: ctx.client }, session, planMarkdown);
  }

  const autoDecision = computeAutoDecision({
    toolName: params.toolName,
    sessionMode: session.mode,
    riskLevel: params.riskLevel,
    logger: ctx.logger,
  });

  if (autoDecision) {
    const selectedOption =
      droidOptions?.some((o) => o.value === autoDecision) === true
        ? autoDecision
        : autoDecision === "cancel"
          ? "cancel"
          : droidOptions
            ? (droidOptions?.find((o) => permissionKindFromOptionValue(o.value) === "allow_once")
                ?.value ??
              droidOptions?.find((o) => o.value !== "cancel")?.value ??
              "proceed_once")
            : autoDecision;

    const isExitSpecMode = params.toolName === "ExitSpecMode";
    const status =
      selectedOption === "cancel" || isExitSpecMode
        ? ("completed" as const)
        : ("in_progress" as const);

    session.toolCallStatus.set(params.toolCallId, status);
    if (status === "completed") {
      session.activeToolCallIds.delete(params.toolCallId);
    }
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status,
        content:
          selectedOption === "cancel"
            ? [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: `Permission denied for \`${params.toolName}\` (${params.riskLevel}).`,
                  },
                },
              ]
            : undefined,
      },
    });
    return { selectedOption };
  }

  let permission: Awaited<ReturnType<AgentSideConnection["requestPermission"]>>;
  try {
    permission = await ctx.client.requestPermission({
      sessionId: session.id,
      toolCall: {
        toolCallId: params.toolCallId,
        title: params.toolCallTitle,
        rawInput: toolCallRawInputForClient(params.rawInput),
        kind: params.toolCallKind,
        locations: params.toolCallLocations,
        content: params.toolCallContent,
      },
      options: acpOptions,
    });
  } catch (error) {
    ctx.logger.error("requestPermission failed:", error);
    session.toolCallStatus.set(params.toolCallId, "completed");
    session.activeToolCallIds.delete(params.toolCallId);
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `Permission request failed for \`${params.toolName}\`. Cancelling the operation.`,
            },
          },
        ],
      },
    });
    return { selectedOption: "cancel" };
  }

  let selectedOption = "cancel";
  if (permission.outcome.outcome === "selected") {
    selectedOption = permission.outcome.optionId;
  } else {
    selectedOption = "cancel";
  }

  if (params.toolName === "ExitSpecMode") {
    const mapped = mapExitSpecModeSelection(selectedOption);
    selectedOption = mapped.droidSelectedOption;

    if (mapped.nextMode) {
      session.mode = mapped.nextMode;
      await ctx.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: mapped.nextMode,
        },
      });
    }
  }

  const isExitSpecMode = params.toolName === "ExitSpecMode";
  const status =
    selectedOption === "cancel" || isExitSpecMode
      ? ("completed" as const)
      : ("in_progress" as const);

  session.toolCallStatus.set(params.toolCallId, status);
  if (status === "completed") {
    session.activeToolCallIds.delete(params.toolCallId);
  }

  // Close ExitSpecMode prompts explicitly so the UI doesn't leave them hanging.
  if (isExitSpecMode) {
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status,
        content:
          selectedOption === "cancel"
            ? [
                {
                  type: "content",
                  content: { type: "text", text: "Staying in Spec mode." },
                },
              ]
            : undefined,
      },
    });
  } else if (selectedOption !== "cancel") {
    // If the user explicitly rejected the permission prompt, the Client will already
    // reflect that in the UI (e.g. "Rejected"). Avoid overwriting it with a "completed" status.
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: params.toolCallId,
        status,
      },
    });
  }

  return { selectedOption };
}
