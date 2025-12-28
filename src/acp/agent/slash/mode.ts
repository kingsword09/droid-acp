import { ACP_MODES, type AcpModeId } from "../../../types.ts";
import { ACP_MODE_TO_DROID_AUTONOMY } from "../../constants.ts";
import type { Session } from "../../session-types.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleMode(
  ctx: AgentRuntime,
  session: Session,
  trimmedArgs: string,
): Promise<void> {
  const inputMode = trimmedArgs.toLowerCase() as AcpModeId;
  if (trimmedArgs && ACP_MODES.includes(inputMode)) {
    session.mode = inputMode;
    session.droid.setMode(ACP_MODE_TO_DROID_AUTONOMY[inputMode]);
    await sendAgentMessage(ctx.client, session, `Autonomy mode changed to: **${inputMode}**`);
    await ctx.client.sessionUpdate({
      sessionId: session.id,
      update: { sessionUpdate: "current_mode_update", currentModeId: inputMode },
    });
    return;
  }

  const modeList = ACP_MODES.map((m) => {
    const current = m === session.mode ? " **(current)**" : "";
    return `- ${m}${current}`;
  }).join("\n");
  await sendAgentMessage(
    ctx.client,
    session,
    `**Current mode:** ${session.mode}\n\n**Available modes:**\n${modeList}`,
  );
}
