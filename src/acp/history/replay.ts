import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { streamFactorySessionJsonl } from "../../factory-sessions.ts";
import type { Logger } from "../../utils.ts";
import type { Session } from "../session-types.ts";
import { sanitizeHistoryTextForDisplay } from "../text.ts";

export async function replayHistoryFromJsonl(
  ctx: { client: AgentSideConnection; logger: Logger },
  session: Session,
  jsonlPath: string,
): Promise<void> {
  ctx.logger.log("Replaying session history from:", jsonlPath);

  for await (const entry of streamFactorySessionJsonl(jsonlPath)) {
    const record = entry as { type?: unknown; message?: unknown; id?: unknown };
    if (record.type !== "message") continue;

    const message = record.message as { role?: unknown; content?: unknown };
    const role = message?.role;
    const content = message?.content;
    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    if (!Array.isArray(content)) continue;

    const messageId = typeof record.id === "string" ? record.id : "message";
    await replayHistoryMessage(ctx, session, { role, id: messageId, content });
  }
}

export async function replayHistoryFromInitMessages(
  ctx: { client: AgentSideConnection; logger: Logger },
  session: Session,
  messages: unknown[],
): Promise<void> {
  ctx.logger.log("Replaying session history from init result (messages):", messages.length);

  for (const entry of messages) {
    const message = entry as { role?: unknown; content?: unknown; id?: unknown };
    const role = message?.role;
    const content = message?.content;

    if (role !== "user" && role !== "assistant" && role !== "system") continue;
    if (!Array.isArray(content)) continue;

    const id = typeof message.id === "string" ? message.id : "message";
    await replayHistoryMessage(ctx, session, { role, id, content });
  }
}

async function replayHistoryMessage(
  ctx: { client: AgentSideConnection; logger: Logger },
  session: Session,
  message: { role: "user" | "assistant" | "system"; id: string; content: unknown[] },
): Promise<void> {
  if (message.role === "user") {
    for (const block of message.content) {
      const b = block as Record<string, unknown>;
      const blockType = b.type as string | undefined;
      if (blockType === "tool_result") continue;

      if (blockType === "text") {
        const text = typeof b.text === "string" ? b.text : "";
        const cleaned = sanitizeHistoryTextForDisplay(text);
        if (cleaned.length > 0) {
          await ctx.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: cleaned },
            },
          });
        }
        continue;
      }

      if (blockType === "image") {
        const source = b.source as { type?: unknown; data?: unknown } | undefined;
        const data = typeof source?.data === "string" ? source.data : null;
        const mimeType =
          (typeof b.media_type === "string" ? b.media_type : null) ??
          (typeof b.mediaType === "string" ? b.mediaType : null);
        if (data && mimeType) {
          await ctx.client.sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "image", data, mimeType },
            },
          });
        }
        continue;
      }
    }
    return;
  }

  if (message.role === "assistant") {
    const textParts = message.content
      .filter((c) => (c as Record<string, unknown>)?.type === "text")
      .map((c) => ((c as Record<string, unknown>)?.text as string) ?? "")
      .filter((t) => typeof t === "string" && t.length > 0)
      .map((t) => sanitizeHistoryTextForDisplay(t))
      .filter((t) => t.length > 0);

    if (textParts.length > 0) {
      await ctx.client.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: textParts.join("") },
        },
      });
    }
  }
}
