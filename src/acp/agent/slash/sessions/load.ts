import {
  listFactorySessions,
  readFactorySessionStart,
  resolveFactorySessionJsonlPath,
  type FactorySessionRecord,
} from "../../../../factory-sessions.ts";
import { createDroidAdapter } from "../../../../droid-adapter.ts";
import { UUID_RE } from "../../../constants.ts";
import { buildHistoryTranscriptFromJsonl } from "../../../history/transcript.ts";
import { replayHistoryFromJsonl } from "../../../history/replay.ts";
import { attachSession } from "../../../session/attach-session.ts";
import type { Session } from "../../../session-types.ts";
import { formatTimestampForDisplay, sanitizeSessionTitle } from "../../../text.ts";
import { sendAgentMessage } from "../../messages.ts";
import type { AgentRuntime } from "../../runtime.ts";
import { filterEmptySessions } from "./shared.ts";

async function getOrFetchListing(
  ctx: AgentRuntime,
  session: Session,
): Promise<FactorySessionRecord[]> {
  if (session.lastSessionsListing?.sessions) return session.lastSessionsListing.sessions;
  const { sessions } = await listFactorySessions({ cwd: session.cwd, cursor: null, pageSize: 20 });
  const filtered = filterEmptySessions(sessions);
  session.lastSessionsListing = { scope: "cwd", sessions: filtered };
  return filtered;
}

async function resolveSessionLoadTarget(
  ctx: AgentRuntime,
  session: Session,
  rawTarget: string,
): Promise<string | null> {
  const target = rawTarget.trim();
  if (!target) return null;

  const lower = target.toLowerCase();
  if (lower === "last" || lower === "latest") {
    const listing = await getOrFetchListing(ctx, session);
    const first = listing[0];
    if (!first) {
      await sendAgentMessage(
        ctx.client,
        session,
        `No sessions found for:\n\n- cwd: ${session.cwd}\n\nTry: /sessions all`,
      );
      return null;
    }
    return first.sessionId;
  }

  if (/^\d+$/.test(target)) {
    const index = Number.parseInt(target, 10);
    if (!Number.isFinite(index) || index <= 0) {
      await sendAgentMessage(ctx.client, session, `Invalid session index: ${target}`);
      return null;
    }

    const listing = await getOrFetchListing(ctx, session);
    const record = listing[index - 1];
    if (!record) {
      await sendAgentMessage(
        ctx.client,
        session,
        `Session index out of range: ${index}\n\nRun \`/sessions\` to refresh the list.`,
      );
      return null;
    }
    return record.sessionId;
  }

  if (UUID_RE.test(target)) return target;

  const listing = await getOrFetchListing(ctx, session);
  const matches = listing.filter((s) => s.sessionId.toLowerCase().startsWith(target.toLowerCase()));
  if (matches.length === 1) return matches[0].sessionId;

  if (matches.length === 0) {
    await sendAgentMessage(
      ctx.client,
      session,
      `No session matches that id prefix: ${target}\n\nRun \`/sessions\` or \`/sessions all\` to list sessions.`,
    );
    return null;
  }

  const scope = session.lastSessionsListing?.scope ?? "cwd";
  const formatLine = (s: FactorySessionRecord): string => {
    const idx = listing.findIndex((x) => x.sessionId === s.sessionId);
    const n = idx >= 0 ? `${idx + 1}. ` : "";
    const time = s.updatedAt ? ` — ${formatTimestampForDisplay(s.updatedAt)}` : "";
    const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
    const title = cleanedTitle.length > 0 ? ` — ${cleanedTitle}` : "";
    const cwdSuffix = scope === "all" ? ` (${s.cwd})` : "";
    return `${n}${s.sessionId}${cwdSuffix}${title}${time}`;
  };

  const lines = matches.slice(0, 10).map(formatLine);
  await sendAgentMessage(
    ctx.client,
    session,
    [
      `Multiple sessions match that id prefix: ${target}`,
      "",
      ...lines.map((l) => `- ${l}`),
      "",
      "Use: /sessions load <#>",
    ].join("\n"),
  );
  return null;
}

export async function handleSessionsLoad(
  ctx: AgentRuntime,
  session: Session,
  parts: string[],
): Promise<void> {
  const rawTarget = parts[1] ?? "";
  if (rawTarget.length === 0) {
    await sendAgentMessage(
      ctx.client,
      session,
      "Usage:\n\n- /sessions load <#>\n- /sessions load <session_id_prefix>\n- /sessions load <full_session_id>",
    );
    return;
  }

  const targetSessionId = await resolveSessionLoadTarget(ctx, session, rawTarget);
  if (!targetSessionId) return;

  await sendAgentMessage(ctx.client, session, `Loading session: ${targetSessionId}…`);

  const jsonlPath = await resolveFactorySessionJsonlPath({
    sessionId: targetSessionId,
    cwd: session.cwd,
  });
  if (!jsonlPath) {
    await sendAgentMessage(
      ctx.client,
      session,
      `Session history not found on disk for: ${targetSessionId}`,
    );
    return;
  }

  const header = await readFactorySessionStart(jsonlPath);
  const cwd = header?.cwd ?? session.cwd;

  try {
    await session.droid.stop();
  } catch {}

  let droid = createDroidAdapter({ cwd, logger: ctx.logger, resumeSessionId: targetSessionId });
  let initResult = await droid.start();
  const resumed = initResult.sessionId === targetSessionId;
  if (!resumed) {
    try {
      await droid.stop();
    } catch {}
    droid = createDroidAdapter({ cwd, logger: ctx.logger });
    initResult = await droid.start();
  }

  const { session: newSession } = attachSession({
    sessionId: session.id,
    cwd,
    droid,
    initResult,
    title: header?.title ? sanitizeSessionTitle(header.title) : null,
    client: ctx.client,
    logger: ctx.logger,
    sessions: ctx.sessions,
    handlers: ctx.getAttachHandlers(),
  });

  if (!resumed) {
    const transcript = await buildHistoryTranscriptFromJsonl(jsonlPath, 12000);
    if (transcript.length > 0) {
      newSession.pendingHistoryContext = transcript;
    }
    await sendAgentMessage(
      ctx.client,
      newSession,
      `\n\nNote: history is loaded from disk for ${targetSessionId}, but Droid could not resume this session id.\n\nYour next message will automatically include a transcript as context (so Droid can continue without a Factory login).`,
    );
  }

  await replayHistoryFromJsonl({ client: ctx.client, logger: ctx.logger }, newSession, jsonlPath);
}
