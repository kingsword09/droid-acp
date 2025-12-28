import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { createDroidAdapter, type DroidAdapter } from "../../droid-adapter.ts";
import type { InitSessionResult, PermissionRequest, DroidNotification } from "../../types.ts";
import { ACP_MODE_TO_DROID_AUTONOMY } from "../constants.ts";
import type { Session } from "../session-types.ts";
import { attachSession } from "./attach-session.ts";
import type { Logger } from "../../utils.ts";

export async function finalizeActiveToolCalls(params: {
  client: AgentSideConnection;
  session: Session;
  message: string;
}): Promise<void> {
  const active = [...params.session.activeToolCallIds];
  if (active.length === 0) return;

  params.session.activeToolCallIds.clear();
  for (const toolCallId of active) {
    params.session.toolCallStatus.set(toolCallId, "completed");
    await params.client.sessionUpdate({
      sessionId: params.session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: params.message },
          },
        ],
      },
    });
  }
}

export async function restartDroidSession(
  ctx: {
    client: AgentSideConnection;
    logger: Logger;
    sessions: Map<string, Session>;
    handlers: {
      handleNotification: (session: Session, n: DroidNotification) => Promise<void>;
      handlePermission: (
        session: Session,
        params: PermissionRequest,
      ) => Promise<{ selectedOption: string }>;
    };
  },
  params: { sessionId: string; reason: string },
): Promise<void> {
  const session = ctx.sessions.get(params.sessionId);
  if (!session) return;
  if (session.restartPromise) return session.restartPromise;

  const oldDroid = session.droid;
  const cwd = session.cwd;
  const title = session.title;
  const oldMode = session.mode;
  const oldModel = session.model;
  const pendingHistoryContext = session.pendingHistoryContext;
  const resumeSessionId = session.droidSessionId;

  session.keepAliveOnDroidExit = true;
  session.restartPromise = (async () => {
    ctx.logger.log("Restarting droid session:", params.sessionId, "reason:", params.reason);

    // Stop the old process first so we can safely resume/replace it.
    try {
      await oldDroid.stop();
    } catch (err: unknown) {
      ctx.logger.error("Failed to stop droid (during restart):", err);
    }

    const startFresh = async (): Promise<{ droid: DroidAdapter; init: InitSessionResult }> => {
      const droid = createDroidAdapter({ cwd, logger: ctx.logger });
      const init = await droid.start();
      return { droid, init };
    };

    const startResumed = async (
      sessionId: string,
    ): Promise<{ droid: DroidAdapter; init: InitSessionResult }> => {
      const droid = createDroidAdapter({ cwd, logger: ctx.logger, resumeSessionId: sessionId });
      const init = await droid.start();
      return { droid, init };
    };

    let started: { droid: DroidAdapter; init: InitSessionResult };
    try {
      started =
        typeof resumeSessionId === "string" && resumeSessionId.length > 0
          ? await startResumed(resumeSessionId)
          : await startFresh();
    } catch (err: unknown) {
      ctx.logger.error("Failed to resume droid session, starting fresh:", err);
      started = await startFresh();
    }

    const { droid, init } = started;
    const { session: newSession } = attachSession({
      sessionId: params.sessionId,
      cwd,
      droid,
      initResult: init,
      title: typeof title === "string" ? title : null,
      client: ctx.client,
      logger: ctx.logger,
      sessions: ctx.sessions,
      handlers: ctx.handlers,
    });

    newSession.pendingHistoryContext = pendingHistoryContext;

    // Best-effort: preserve the current mode/model across the restart.
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

    newSession.cancelled = false;
  })()
    .catch((err: unknown) => {
      ctx.logger.error("restartDroidSession failed:", err);
    })
    .finally(() => {
      const current = ctx.sessions.get(params.sessionId);
      if (current) {
        current.restartPromise = null;
        current.keepAliveOnDroidExit = false;
        current.cancelled = false;
      }
    });

  return session.restartPromise;
}

export async function getReadySession(
  ctx: {
    sessions: Map<string, Session>;
    restartDroidSession: (params: { sessionId: string; reason: string }) => Promise<void>;
  },
  params: { sessionId: string; reason: string },
): Promise<Session> {
  const { sessionId } = params;
  let session = ctx.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (session.restartPromise) {
    await session.restartPromise;
    session = ctx.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
  }

  if (session.cancelled || !session.droid.isRunning()) {
    await ctx.restartDroidSession({ sessionId, reason: params.reason });
    session = ctx.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
  }

  return session;
}
