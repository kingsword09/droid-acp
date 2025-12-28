import { listFactorySessions } from "../../../../factory-sessions.ts";
import type { Session } from "../../../session-types.ts";
import { formatTimestampForDisplay, sanitizeSessionTitle } from "../../../text.ts";
import { sendAgentMessage } from "../../messages.ts";
import type { AgentRuntime } from "../../runtime.ts";
import { filterEmptySessions } from "./shared.ts";

export async function handleSessionsList(ctx: AgentRuntime, session: Session): Promise<void> {
  const { sessions: raw } = await listFactorySessions({
    cwd: session.cwd,
    cursor: null,
    pageSize: 20,
  });
  const sessions = filterEmptySessions(raw);

  if (sessions.length === 0) {
    await sendAgentMessage(
      ctx.client,
      session,
      `No sessions found for:\n\n- cwd: ${session.cwd}\n\nTry: /sessions all`,
    );
    return;
  }

  session.lastSessionsListing = { scope: "cwd", sessions };

  const lines = sessions.map((s, i) => {
    const time = s.updatedAt ? ` — ${formatTimestampForDisplay(s.updatedAt)}` : "";
    const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
    const title = cleanedTitle.length > 0 ? ` — ${cleanedTitle}` : "";
    return `${i + 1}. ${s.sessionId}${title}${time}`;
  });

  await sendAgentMessage(
    ctx.client,
    session,
    [
      `**Sessions (${session.cwd})**`,
      "",
      ...lines,
      "",
      "Use:",
      "- /sessions load <#>",
      "- /sessions <#>",
      "- /sessions load <session_id_prefix>",
    ]
      .join("\n")
      .trim(),
  );
}

export async function handleSessionsAll(ctx: AgentRuntime, session: Session): Promise<void> {
  const { sessions: raw } = await listFactorySessions({
    cwd: null,
    cursor: null,
    pageSize: 20,
    preferredCwd: session.cwd,
  });
  const sessions = filterEmptySessions(raw);

  if (sessions.length === 0) {
    await sendAgentMessage(ctx.client, session, "No sessions found in local history.");
    return;
  }

  session.lastSessionsListing = { scope: "all", sessions };

  const lines = sessions.map((s, i) => {
    const time = s.updatedAt ? ` — ${formatTimestampForDisplay(s.updatedAt)}` : "";
    const cleanedTitle = s.title ? sanitizeSessionTitle(s.title) : "";
    const title = cleanedTitle.length > 0 ? ` — ${cleanedTitle}` : "";
    return `${i + 1}. ${s.sessionId} (${s.cwd})${title}${time}`;
  });

  await sendAgentMessage(
    ctx.client,
    session,
    [
      "**Recent Sessions**",
      "",
      ...lines,
      "",
      "Use:",
      "- /sessions load <#>",
      "- /sessions <#>",
      "- /sessions load <session_id_prefix>",
    ]
      .join("\n")
      .trim(),
  );
}
