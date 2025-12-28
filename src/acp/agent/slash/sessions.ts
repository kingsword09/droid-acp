import type { Session } from "../../session-types.ts";
import { isExperimentSessionsEnabled } from "../../flags.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";
import { handleSessionsAll, handleSessionsList } from "./sessions/list.ts";
import { handleSessionsLoad } from "./sessions/load.ts";

export async function handleSessions(
  ctx: AgentRuntime,
  session: Session,
  trimmedArgs: string,
): Promise<void> {
  if (!isExperimentSessionsEnabled()) {
    await sendAgentMessage(
      ctx.client,
      session,
      "Experimental feature disabled.\n\nEnable with `npx droid-acp --experiment-sessions` (or set `DROID_ACP_EXPERIMENT_SESSIONS=1`).",
    );
    return;
  }

  const parts = trimmedArgs.split(/\s+/).filter((p) => p.length > 0);
  let sub = parts[0]?.toLowerCase();

  if (sub && /^\d+$/.test(sub)) {
    parts.unshift("load");
    sub = "load";
  }

  if (!sub || sub === "list") {
    await handleSessionsList(ctx, session);
    return;
  }

  if (sub === "all") {
    await handleSessionsAll(ctx, session);
    return;
  }

  if (sub === "load") {
    await handleSessionsLoad(ctx, session, parts);
    return;
  }

  await sendAgentMessage(
    ctx.client,
    session,
    "Usage:\n\n- /sessions (list current cwd)\n- /sessions all (list global)\n- /sessions load <#|id_prefix|session_id>\n- /sessions <#>",
  );
}
