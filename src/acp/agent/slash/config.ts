import type { Session } from "../../session-types.ts";
import { sendAgentMessage } from "../messages.ts";
import type { AgentRuntime } from "../runtime.ts";

export async function handleConfig(ctx: AgentRuntime, session: Session): Promise<void> {
  const config = [
    `**Session Configuration:**`,
    `- Session ID: ${session.id}`,
    `- Working Directory: ${session.cwd}`,
    `- Model: ${session.model}`,
    `- Mode: ${session.mode}`,
  ].join("\n");
  await sendAgentMessage(ctx.client, session, config);
}
