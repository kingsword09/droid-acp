import type {
  CancelNotification,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
} from "@agentclientprotocol/sdk";
import { ACP_MODES, type AcpModeId } from "../../types.ts";
import { ACP_MODE_TO_DROID_AUTONOMY } from "../constants.ts";
import { sanitizeSessionTitle } from "../text.ts";
import { convertAcpPromptToDroidMessage } from "../prompt/convert.ts";
import {
  finalizeActiveToolCalls,
  getReadySession,
  restartDroidSession,
} from "../session/restart.ts";
import type { AgentRuntime } from "./runtime.ts";
import { handleSlashCommand } from "./slash/handle.ts";

function deriveSessionTitle(text: string): string | null {
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const cleaned = sanitizeSessionTitle(firstLine);
  if (cleaned.length === 0) return null;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
}

export async function prompt(ctx: AgentRuntime, request: PromptRequest): Promise<PromptResponse> {
  let session = ctx.sessions.get(request.sessionId);
  if (!session) throw new Error(`Session not found: ${request.sessionId}`);
  if (session.promptResolve) throw new Error("Another prompt is already in progress");

  session = await getReadySession(
    {
      sessions: ctx.sessions,
      restartDroidSession: (p) =>
        restartDroidSession(
          {
            client: ctx.client,
            logger: ctx.logger,
            sessions: ctx.sessions,
            handlers: ctx.getAttachHandlers(),
          },
          p,
        ),
    },
    { sessionId: request.sessionId, reason: "prompt" },
  );

  ctx.logger.log("prompt:", request.sessionId);

  const converted = convertAcpPromptToDroidMessage(request.prompt);
  let text = converted.text;
  const images = converted.images;

  const derivedTitle = deriveSessionTitle(text);
  const now = new Date().toISOString();
  session.updatedAt = now;
  if ((!session.title || session.title === "New Session") && derivedTitle) {
    session.title = derivedTitle;
  }

  void ctx.client.sessionUpdate({
    sessionId: session.id,
    update: {
      sessionUpdate: "session_info_update",
      title: session.title,
      updatedAt: session.updatedAt,
    },
  });

  if (text.startsWith("/")) {
    const handled = await handleSlashCommand(ctx, session, text);
    if (handled) return { stopReason: "end_turn" };
  }

  if (session.pendingHistoryContext) {
    const historyContext = session.pendingHistoryContext;
    session.pendingHistoryContext = null;
    text = `${text}\n\n<context ref="session_history">\n${historyContext}\n</context>`.trim();
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(
      () => {
        const current = ctx.sessions.get(request.sessionId);
        if (current?.promptResolve) {
          current.promptResolve({ stopReason: "end_turn" });
          current.promptResolve = null;
        }
      },
      5 * 60 * 1000,
    );

    session.promptResolve = resolve;
    session.droid.sendUserMessage({
      text,
      images: images.length > 0 ? images : undefined,
    });

    const originalResolve = session.promptResolve;
    session.promptResolve = (result) => {
      clearTimeout(timeoutId);
      originalResolve?.(result);
    };
  });
}

export async function cancel(ctx: AgentRuntime, request: CancelNotification): Promise<void> {
  const session = ctx.sessions.get(request.sessionId);
  if (!session) return;

  const hasInFlightWork =
    session.promptResolve !== null ||
    session.capture !== null ||
    session.activeToolCallIds.size > 0;
  if (!hasInFlightWork) {
    ctx.logger.log("cancel (no-op):", request.sessionId);
    return;
  }

  ctx.logger.log("cancel:", request.sessionId);
  session.cancelled = true;

  if (session.promptResolve) {
    session.promptResolve({ stopReason: "cancelled" });
    session.promptResolve = null;
  }

  if (session.capture) {
    const capture = session.capture;
    session.capture = null;
    clearTimeout(capture.timeoutId);
    if (capture.finalizeTimeoutId) clearTimeout(capture.finalizeTimeoutId);
    capture.reject(new Error("Cancelled"));
  }

  await finalizeActiveToolCalls({ client: ctx.client, session, message: "Cancelled." });

  void restartDroidSession(
    {
      client: ctx.client,
      logger: ctx.logger,
      sessions: ctx.sessions,
      handlers: ctx.getAttachHandlers(),
    },
    { sessionId: request.sessionId, reason: "cancel" },
  );
}

export async function unstable_setSessionModel(
  ctx: AgentRuntime,
  request: SetSessionModelRequest,
): Promise<SetSessionModelResponse | void> {
  const session = ctx.sessions.get(request.sessionId);
  if (!session) return;

  ctx.logger.log("setSessionModel:", request.modelId);
  session.model = request.modelId;
  session.droid.setModel(request.modelId);
}

export async function setSessionMode(
  ctx: AgentRuntime,
  request: SetSessionModeRequest,
): Promise<SetSessionModeResponse> {
  const session = ctx.sessions.get(request.sessionId);
  if (session) {
    ctx.logger.log("setSessionMode:", request.modeId);
    const modeId = ACP_MODES.includes(request.modeId as AcpModeId)
      ? (request.modeId as AcpModeId)
      : null;
    if (modeId) {
      session.mode = modeId;
      session.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[modeId]);
    }
  }
  return {};
}
