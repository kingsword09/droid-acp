import type { Session } from "../../session-types.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleStatus(ctx: AgentRuntime, session: Session): Promise<void> {
  const status = [
    `**Session Status:**`,
    `- Active Tool Calls: ${session.activeToolCallIds.size}`,
    `- Droid Running: ${session.droid.isRunning()}`,
  ].join("\n");
  await sendAgentMessage(ctx.client, session, status);
}
