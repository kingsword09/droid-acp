import type { AgentSideConnection, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { DroidNotification } from "../../types.ts";
import type { Logger } from "../../utils.ts";
import { isEnvEnabled } from "../../utils.ts";
import { isDebugEnabled } from "../flags.ts";
import type { Session } from "../session-types.ts";
import { buildPermissionToolCallContent } from "../permissions/content.ts";
import { toolCallRawInputForClient, formatPermissionToolCallTitle } from "../permissions/format.ts";
import { permissionLocationsFromRawInput } from "../permissions/paths.ts";
import { extractSpecTitleAndPlan } from "../permissions/spec.ts";
import { toolKindFromToolName } from "../permissions/tool-kind.ts";
import { droidAutonomyToAcpModeId } from "../constants.ts";

export async function handleNotification(
  ctx: { client: AgentSideConnection; logger: Logger },
  session: Session,
  n: DroidNotification,
): Promise<void> {
  ctx.logger.log("notification:", n.type);

  // If the user cancelled the current turn, avoid emitting stale tool calls / messages
  // from the previous droid process. We'll restart and resume shortly.
  if (session.cancelled) {
    return;
  }

  switch (n.type) {
    case "settings_updated": {
      const autonomyLevel =
        typeof n.settings.autonomyLevel === "string"
          ? droidAutonomyToAcpModeId(n.settings.autonomyLevel)
          : null;

      if (autonomyLevel && autonomyLevel !== session.mode) {
        session.mode = autonomyLevel;
        await ctx.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: autonomyLevel,
          },
        });
      }

      if (typeof n.settings.modelId === "string") {
        session.model = n.settings.modelId;
      }
      break;
    }

    case "message":
      if (n.role === "assistant") {
        const suppressAssistantOutput =
          session.capture?.purpose === "compress_summary" && !isEnvEnabled(process.env.DROID_DEBUG);

        if (session.capture && n.text) {
          const capture = session.capture;
          capture.buffer += n.text;

          if (capture.purpose === "compress_summary" && /<\/summary>/i.test(capture.buffer)) {
            session.capture = null;
            clearTimeout(capture.timeoutId);
            if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
            capture.resolve(capture.buffer);
          }
        }

        // Handle tool use in message
        if (n.toolUse && isDebugEnabled()) {
          ctx.logger.log("[ToolUse] name:", n.toolUse.name, "suppressed:", suppressAssistantOutput);
        }
        if (n.toolUse && !suppressAssistantOutput) {
          if (n.toolUse.name === "TodoWrite") {
            const todosRaw = (n.toolUse.input as { todos?: unknown })?.todos;
            if (isDebugEnabled()) {
              ctx.logger.log("[TodoWrite] Received input:", typeof todosRaw, todosRaw);
            }

            const toStatus = (status: unknown): "pending" | "in_progress" | "completed" => {
              switch (status) {
                case "pending":
                case "in_progress":
                case "completed":
                  return status;
                default:
                  return "pending";
              }
            };

            let entries: Array<{
              content: string;
              status: "pending" | "in_progress" | "completed";
              priority: "high" | "medium" | "low";
            }> = [];

            if (typeof todosRaw === "string") {
              // Parse string format: "1. [status] content" or "- [status] content"
              const lines = todosRaw.split("\n").filter((line) => line.trim().length > 0);
              entries = lines
                .map((line) => {
                  // Match patterns like "1. [in_progress] Task" or "- [pending] Task"
                  const match = line.match(/^(?:\d+\.|-)?\s*\[(\w+)\]\s*(.+)$/);
                  if (match) {
                    const [, statusStr, content] = match;
                    return {
                      content: content.trim(),
                      status: toStatus(statusStr),
                      priority: "medium" as const,
                    };
                  }
                  return null;
                })
                .filter((e): e is NonNullable<typeof e> => e !== null && e.content.length > 0);
            } else if (Array.isArray(todosRaw)) {
              // Handle array format (legacy)
              entries = todosRaw
                .map((t) => {
                  const todo = t as { content?: unknown; status?: unknown };
                  return {
                    content: typeof todo.content === "string" ? todo.content : "",
                    status: toStatus(todo.status),
                    priority: "medium" as const,
                  };
                })
                .filter((e) => e.content.length > 0);
            }

            if (entries.length > 0) {
              if (isDebugEnabled()) {
                ctx.logger.log(
                  "[TodoWrite] Sending plan_update with",
                  entries.length,
                  "entries:",
                  entries,
                );
              }
              await ctx.client.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "plan",
                  entries,
                },
              });
            }
            break;
          }

          const toolCallId = n.toolUse.id;
          const isExitSpecMode = n.toolUse.name === "ExitSpecMode";
          const existingStatus = session.toolCallStatus.get(toolCallId);
          if (existingStatus !== "completed" && existingStatus !== "failed") {
            if (!session.activeToolCallIds.has(toolCallId)) {
              session.activeToolCallIds.add(toolCallId);
              session.toolNames.set(toolCallId, n.toolUse.name);

              const initialStatus = isExitSpecMode ? "pending" : "in_progress";
              session.toolCallStatus.set(toolCallId, initialStatus);

              const toolName = n.toolUse.name;
              const rawInput = n.toolUse.input;

              const isReadOnlyTool =
                toolName === "Read" ||
                toolName === "Grep" ||
                toolName === "Glob" ||
                toolName === "LS";
              const riskLevelRaw = (rawInput as { riskLevel?: unknown } | null | undefined)
                ?.riskLevel;
              const riskLevel =
                riskLevelRaw === "low" || riskLevelRaw === "medium" || riskLevelRaw === "high"
                  ? riskLevelRaw
                  : isReadOnlyTool
                    ? "low"
                    : "medium";

              const toolCallKind: ToolKind = isExitSpecMode
                ? "switch_mode"
                : toolKindFromToolName(toolName);
              const toolCallLocations = permissionLocationsFromRawInput({
                toolName,
                rawInput,
                cwd: session.cwd,
              });

              const spec = isExitSpecMode ? extractSpecTitleAndPlan(rawInput) : null;
              const toolCallTitle = isExitSpecMode
                ? spec?.title
                  ? `Exit spec mode: ${spec.title}`
                  : "Exit spec mode"
                : formatPermissionToolCallTitle({
                    stage: "run",
                    toolName,
                    riskLevel,
                    rawInput,
                    cwd: session.cwd,
                  });

              const toolCallContent = await buildPermissionToolCallContent({
                toolName,
                riskLevel,
                rawInput,
                cwd: session.cwd,
                planMarkdown: isExitSpecMode ? (spec?.plan ?? null) : null,
              });

              session.toolCallRawInputById.set(toolCallId, rawInput);
              session.toolCallContentById.set(toolCallId, toolCallContent);

              await ctx.client.sessionUpdate({
                sessionId: session.id,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: toolCallTitle,
                  kind: toolCallKind,
                  locations: toolCallLocations,
                  status: initialStatus,
                  rawInput: toolCallRawInputForClient(rawInput),
                  content: toolCallContent,
                },
              });
            } else {
              const status = session.toolCallStatus.get(toolCallId);
              if (status !== "completed" && status !== "failed" && status !== "pending") {
                session.toolCallStatus.set(toolCallId, "in_progress");
                await ctx.client.sessionUpdate({
                  sessionId: session.id,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId,
                    status: "in_progress",
                  },
                });
              }
            }
          }
        }

        // Handle text content
        if (n.text && !suppressAssistantOutput) {
          await ctx.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: n.text },
            },
          });
        }
      }
      break;

    case "tool_result":
      if (!session.activeToolCallIds.has(n.toolUseId)) {
        session.activeToolCallIds.add(n.toolUseId);
        const name = session.toolNames.get(n.toolUseId) ?? "Tool";
        await ctx.client.sessionUpdate({
          sessionId: session.id,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: n.toolUseId,
            title: `Running ${name}`,
            status: "in_progress",
          },
        });
      }

      const finalStatus = n.isError ? ("failed" as const) : ("completed" as const);

      const preserved = (session.toolCallContentById.get(n.toolUseId) ?? []).filter(
        (c) => c.type === "diff" || c.type === "terminal",
      );
      const merged: ToolCallContent[] = [
        ...preserved,
        {
          type: "content",
          content: {
            type: "text",
            text: n.content,
          },
        },
      ];
      session.toolCallContentById.set(n.toolUseId, merged);

      // Send the tool response content + completion status
      await ctx.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: n.toolUseId,
          content: merged,
          rawOutput: n.content,
          status: finalStatus,
        },
      });

      session.toolCallStatus.set(n.toolUseId, finalStatus);
      session.activeToolCallIds.delete(n.toolUseId);
      break;

    case "error":
      if (session.capture) {
        const capture = session.capture;
        session.capture = null;
        clearTimeout(capture.timeoutId);
        if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
        capture.reject(new Error(n.message));
      }
      await ctx.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${n.message}` },
        },
      });
      if (session.promptResolve) {
        session.promptResolve({ stopReason: "end_turn" });
        session.promptResolve = null;
      }
      break;

    case "complete":
      if (session.capture) {
        const capture = session.capture;
        if (!capture.finalizeTimeoutId) {
          capture.finalizeTimeoutId = setTimeout(() => {
            if (session.capture !== capture) return;
            session.capture = null;
            clearTimeout(capture.timeoutId);
            capture.resolve(capture.buffer);
          }, 1000);
        }
        break;
      }
      if (session.promptResolve) {
        session.promptResolve({ stopReason: "end_turn" });
        session.promptResolve = null;
      }
      break;
  }
}
