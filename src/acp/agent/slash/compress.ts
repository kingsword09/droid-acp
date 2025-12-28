import { createDroidAdapter } from "../../../droid-adapter.ts";
import { ACP_MODE_TO_DROID_AUTONOMY } from "../../constants.ts";
import type { Session } from "../../session-types.ts";
import { attachSession } from "../../session/attach-session.ts";
import { sanitizeHistoryTextForDisplay } from "../../text.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

function extractSummaryText(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  if (match) return match[1]?.trim() ?? "";
  return text.trim();
}

function captureNextAssistantText(
  session: Session,
  prompt: string,
  options?: { timeoutMs?: number },
): Promise<string> {
  if (session.capture) return Promise.reject(new Error("Capture already in progress"));

  return new Promise((resolve, reject) => {
    const timeoutMs = options?.timeoutMs ?? 2 * 60 * 1000;
    const timeoutId = setTimeout(() => {
      if (!session.capture) return;
      const capture = session.capture;
      session.capture = null;
      if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
      capture.reject(new Error("Timed out while waiting for summary"));
    }, timeoutMs);

    session.capture = {
      purpose: "compress_summary",
      buffer: "",
      timeoutId,
      finalizeTimeoutId: null,
      resolve: (t: string) => resolve(t),
      reject: (e: Error) => reject(e),
    };

    session.droid.sendUserMessage({ text: prompt });
  });
}

export async function handleCompress(
  ctx: AgentRuntime,
  session: Session,
  trimmedArgs: string,
): Promise<void> {
  if (!session.droid.isRunning()) {
    await sendAgentMessage(ctx.client, session, "Droid is not running.");
    return;
  }
  if (session.capture) {
    await sendAgentMessage(ctx.client, session, "Another operation is already in progress.");
    return;
  }

  const extra = trimmedArgs.length > 0 ? `\n\nExtra instructions: ${trimmedArgs}` : "";
  const summaryPrompt = [
    "Create a compact handoff summary of our conversation so far.",
    "",
    "Requirements:",
    "- Keep it short and information-dense.",
    "- Include: goal, current state, key decisions, important files/paths, and next TODOs.",
    "- Do NOT include tool call logs, <system-reminder>, or <context> blocks.",
    "- Output must be ONLY a single <summary>...</summary> block.",
    extra,
  ]
    .join("\n")
    .trim();

  await sendAgentMessage(ctx.client, session, "Compressing conversation history…");

  let summaryRaw: string;
  try {
    summaryRaw = await captureNextAssistantText(session, summaryPrompt, {
      timeoutMs: 2 * 60 * 1000,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendAgentMessage(ctx.client, session, `Failed to generate summary: ${msg}`);
    return;
  }

  const summaryText = extractSummaryText(summaryRaw);
  const cleanedSummary = sanitizeHistoryTextForDisplay(summaryText);
  if (cleanedSummary.length === 0) {
    await sendAgentMessage(
      ctx.client,
      session,
      "Compression failed: summary was empty. Try again with fewer instructions.",
    );
    return;
  }

  const oldDroid = session.droid;
  const oldMode = session.mode;
  const oldModel = session.model;
  const title = session.title;
  const cwd = session.cwd;

  await sendAgentMessage(
    ctx.client,
    session,
    "Starting a fresh Droid session with summary context…",
  );

  const newDroid = createDroidAdapter({ cwd, logger: ctx.logger });
  const initResult = await newDroid.start();
  const { session: newSession } = attachSession({
    sessionId: session.id,
    cwd,
    droid: newDroid,
    initResult,
    title,
    client: ctx.client,
    logger: ctx.logger,
    sessions: ctx.sessions,
    handlers: ctx.getAttachHandlers(),
  });

  newSession.mode = oldMode;
  newSession.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[oldMode]);
  await ctx.client.sessionUpdate({
    sessionId: newSession.id,
    update: {
      sessionUpdate: "current_mode_update",
      currentModeId: oldMode,
    },
  });

  if (newSession.availableModels.some((m) => m.id === oldModel)) {
    newSession.model = oldModel;
    newSession.droid.setModel(oldModel);
  }

  await oldDroid.stop();

  newSession.pendingHistoryContext = cleanedSummary;

  await sendAgentMessage(
    ctx.client,
    newSession,
    "Compression complete.\n\nYour next message will automatically include the summary context.",
  );
}
