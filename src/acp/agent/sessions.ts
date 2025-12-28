import type {
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
} from "@agentclientprotocol/sdk";
import {
  listFactorySessions,
  readFactorySessionStart,
  resolveFactorySessionJsonlPath,
} from "../../factory-sessions.ts";
import { createDroidAdapter } from "../../droid-adapter.ts";
import type { Session } from "../session-types.ts";
import { replayHistoryFromInitMessages, replayHistoryFromJsonl } from "../history/replay.ts";
import { sanitizeSessionTitle } from "../text.ts";
import { attachSession } from "../session/attach-session.ts";
import { isExperimentSessionsEnabled } from "../flags.ts";
import { getModesState, getModelsState } from "./state.ts";
import type { AgentRuntime } from "./runtime.ts";

function loadDisabledError(action: string): Error {
  return new Error(
    `Session ${action} is experimental. Start droid-acp with --experiment-sessions (or set DROID_ACP_EXPERIMENT_SESSIONS=1).`,
  );
}

function modelsStateFromSession(session: Session): NonNullable<LoadSessionResponse["models"]> {
  return {
    availableModels: session.availableModels.map((m) => ({ modelId: m.id, name: m.displayName })),
    currentModelId: session.model,
  };
}

async function stopAndDropSession(ctx: AgentRuntime, sessionId: string): Promise<void> {
  const existing = ctx.sessions.get(sessionId);
  if (!existing) return;
  try {
    await existing.droid.stop();
  } catch {}
  ctx.sessions.delete(sessionId);
}

export async function newSession(
  ctx: AgentRuntime,
  request: NewSessionRequest,
): Promise<NewSessionResponse> {
  const cwd = request.cwd || process.cwd();
  ctx.logger.log("newSession:", cwd);

  const droid = createDroidAdapter({ cwd, logger: ctx.logger });
  const initResult = await droid.start();

  const sessionId = initResult.sessionId;
  const { initialMode } = attachSession({
    sessionId,
    cwd,
    droid,
    initResult,
    client: ctx.client,
    logger: ctx.logger,
    sessions: ctx.sessions,
    handlers: ctx.getAttachHandlers(),
  });

  return {
    sessionId,
    models: getModelsState(initResult),
    modes: getModesState(initialMode),
  };
}

export async function loadSession(
  ctx: AgentRuntime,
  request: LoadSessionRequest,
): Promise<LoadSessionResponse> {
  if (!isExperimentSessionsEnabled()) throw loadDisabledError("load");

  const requestCwd = request.cwd || process.cwd();
  ctx.logger.log("loadSession:", request.sessionId, requestCwd);

  const existing = ctx.sessions.get(request.sessionId);
  if (existing?.droid.isRunning()) {
    return { models: modelsStateFromSession(existing), modes: getModesState(existing.mode) };
  }

  await stopAndDropSession(ctx, request.sessionId);

  const jsonlPath = await resolveFactorySessionJsonlPath({
    sessionId: request.sessionId,
    cwd: requestCwd,
  });

  const header = jsonlPath ? await readFactorySessionStart(jsonlPath) : null;
  const cwd = header?.cwd ?? requestCwd;

  const droid = createDroidAdapter({ cwd, logger: ctx.logger, resumeSessionId: request.sessionId });
  const initResult = await droid.start();

  if (initResult.sessionId !== request.sessionId) {
    await droid.stop();
    throw new Error(
      `Failed to load session: expected ${request.sessionId} but got ${initResult.sessionId}`,
    );
  }

  const { session, initialMode } = attachSession({
    sessionId: request.sessionId,
    cwd,
    droid,
    initResult,
    title: header?.title ? sanitizeSessionTitle(header.title) : null,
    client: ctx.client,
    logger: ctx.logger,
    sessions: ctx.sessions,
    handlers: ctx.getAttachHandlers(),
  });

  if (jsonlPath) {
    await replayHistoryFromJsonl({ client: ctx.client, logger: ctx.logger }, session, jsonlPath);
  } else if (Array.isArray(initResult.session?.messages)) {
    await replayHistoryFromInitMessages(
      { client: ctx.client, logger: ctx.logger },
      session,
      initResult.session.messages,
    );
  } else {
    throw new Error(`Session history not found for ${request.sessionId}`);
  }

  return { models: getModelsState(initResult), modes: getModesState(initialMode) };
}

export async function unstable_listSessions(
  ctx: AgentRuntime,
  request: ListSessionsRequest,
): Promise<ListSessionsResponse> {
  if (!isExperimentSessionsEnabled()) throw loadDisabledError("list");

  ctx.logger.log("listSessions:", request.cwd ?? "<unset>", "cursor:", request.cursor ?? "<unset>");

  const { sessions, nextCursor } = await listFactorySessions({
    cwd: request.cwd ?? null,
    cursor: request.cursor ?? null,
    preferredCwd: request.cwd ?? process.cwd(),
  });
  ctx.logger.log("listSessions result:", sessions.length, "nextCursor:", nextCursor ?? "<none>");

  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title ? sanitizeSessionTitle(s.title) : null,
      updatedAt: s.updatedAt,
    })),
    nextCursor,
  };
}

export async function unstable_resumeSession(
  ctx: AgentRuntime,
  request: ResumeSessionRequest,
): Promise<ResumeSessionResponse> {
  if (!isExperimentSessionsEnabled()) throw loadDisabledError("resume");

  const cwd = request.cwd || process.cwd();
  ctx.logger.log("resumeSession:", request.sessionId, cwd);

  const existing = ctx.sessions.get(request.sessionId);
  if (existing?.droid.isRunning()) {
    return { models: modelsStateFromSession(existing), modes: getModesState(existing.mode) };
  }

  await stopAndDropSession(ctx, request.sessionId);

  const droid = createDroidAdapter({ cwd, logger: ctx.logger, resumeSessionId: request.sessionId });
  const initResult = await droid.start();

  if (initResult.sessionId !== request.sessionId) {
    await droid.stop();
    throw new Error(
      `Failed to resume session: expected ${request.sessionId} but got ${initResult.sessionId}`,
    );
  }

  const { initialMode } = attachSession({
    sessionId: request.sessionId,
    cwd,
    droid,
    initResult,
    client: ctx.client,
    logger: ctx.logger,
    sessions: ctx.sessions,
    handlers: ctx.getAttachHandlers(),
  });

  return { models: getModelsState(initResult), modes: getModesState(initialMode) };
}
